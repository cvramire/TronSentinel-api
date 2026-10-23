#!/usr/bin/env python3
"""Diagnóstico de overfitting/underfitting de TronSentinel (v2).

Reglas aplicadas (docs/TRAINING_GOVERNANCE.md):
- Línea base nula de PR-AUC = prevalencia de la partición. Se elimina la regla
  ``validation_pr_auc < 0.50``; el subajuste se evalúa con el IC 95 % de la
  mejora sobre la prevalencia.
- Tracking ampliado hasta 1.000 estimadores con regla de early stopping
  predefinida; el mínimo observado es exploratorio, no un parámetro aprobado.
- Cinco experimentos de regularización independientes.
- Semillas repetidas (30 académicas / 10 rápidas) y bootstrap agrupado por
  ``matchedCaseId`` con diferencias pareadas.
- La selección usa solo validación. El test no se abre salvo ``--include-test``,
  que consulta el ledger de particiones abiertas.

El módulo no modifica el modelo desplegado ni consulta el holdout externo.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Iterable

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.base import BaseEstimator, ClassifierMixin  # noqa: E402
from sklearn.ensemble import GradientBoostingClassifier  # noqa: E402
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score  # noqa: E402
from sklearn.model_selection import GroupKFold, learning_curve, validation_curve  # noqa: E402

from onchain_governance import (  # noqa: E402
    ACADEMIC_BOOTSTRAP_REPETITIONS,
    ACADEMIC_SEED_COUNT,
    DEFAULT_EARLY_STOPPING_MIN_DELTA,
    DEFAULT_EARLY_STOPPING_PATIENCE,
    DEFAULT_ESTIMATOR_GRID,
    DEFAULT_MAX_ESTIMATORS,
    DEFAULT_MIN_PR_AUC_LIFT,
    REGULARIZATION_EXPERIMENTS,
    early_stopping_select,
    experiments_as_dicts,
    find_openings,
    grouped_bootstrap,
    load_ledger,
    pr_auc_lift_assessment,
    record_opening,
    seed_schedule,
    sha256_file,
)


META_COLUMNS = {
    "cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target",
}
DEPLOYED_CONFIG = {
    "n_estimators": 150,
    "learning_rate": 0.04,
    "max_depth": 1,
    "min_samples_leaf": 20,
    "subsample": 0.8,
}
DEPLOYED_EXPERIMENT_KEY = "combined"
DEFAULT_LEDGER = Path(__file__).resolve().parents[2] / "governance" / "data-openings.json"


class BalancedGradientBoostingClassifier(ClassifierMixin, BaseEstimator):
    """Gradient Boosting que calcula pesos balanceados dentro de cada fit."""

    def __init__(
        self,
        n_estimators: int = 150,
        learning_rate: float = 0.04,
        max_depth: int = 1,
        min_samples_leaf: int = 20,
        subsample: float = 0.8,
        random_state: int = 20260927,
    ):
        self.n_estimators = n_estimators
        self.learning_rate = learning_rate
        self.max_depth = max_depth
        self.min_samples_leaf = min_samples_leaf
        self.subsample = subsample
        self.random_state = random_state

    def fit(self, x, y):
        y = np.asarray(y, dtype=np.int8)
        positives = int(y.sum())
        controls = int(len(y) - positives)
        if positives == 0 or controls == 0:
            raise ValueError("FIT_REQUIRES_BOTH_CLASSES")
        weights = np.where(y == 1, len(y) / (2.0 * positives), len(y) / (2.0 * controls))
        self.model_ = GradientBoostingClassifier(
            n_estimators=self.n_estimators,
            learning_rate=self.learning_rate,
            max_depth=self.max_depth,
            min_samples_leaf=self.min_samples_leaf,
            subsample=self.subsample,
            random_state=self.random_state,
        )
        self.model_.fit(x, y, sample_weight=weights)
        self.classes_ = self.model_.classes_
        self.n_features_in_ = self.model_.n_features_in_
        return self

    def predict(self, x):
        return self.model_.predict(x)

    def predict_proba(self, x):
        return self.model_.predict_proba(x)

    def decision_function(self, x):
        return self.model_.decision_function(x)


# ---------------------------------------------------------------------------
# Datos
# ---------------------------------------------------------------------------

def load_development_dataset(dataset_path: str | Path, manifest_path: str | Path):
    dataset_path = Path(dataset_path).expanduser().resolve()
    manifest_path = Path(manifest_path).expanduser().resolve()
    frame = pd.read_csv(dataset_path, low_memory=False)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    feature_names = [name for name in frame.columns if name not in META_COLUMNS]
    if feature_names != manifest["featureNames"]:
        raise ValueError("FEATURE_ORDER_DIFFERS_FROM_MANIFEST")
    expected_hash = manifest.get("datasetSha256")
    if expected_hash and sha256_file(dataset_path) != expected_hash:
        raise ValueError("DATASET_HASH_DIFFERS_FROM_MANIFEST")
    if frame[feature_names].isna().any().any():
        raise ValueError("FEATURES_CONTAIN_NULLS")
    if not np.isfinite(frame[feature_names].to_numpy(dtype=np.float64)).all():
        raise ValueError("FEATURES_CONTAIN_NON_FINITE_VALUES")
    if frame["cohortId"].duplicated().any():
        raise ValueError("DUPLICATE_COHORT_ID")
    if (frame.groupby("matchedCaseId")["datasetSplit"].nunique() != 1).any():
        raise ValueError("MATCHED_GROUP_CROSSES_SPLITS")
    return frame, manifest, feature_names


def split_arrays(frame: pd.DataFrame, feature_names: list[str], include_test: bool = True):
    result = {}
    names = ("train", "validation", "test") if include_test else ("train", "validation")
    for split in names:
        part = frame.loc[frame["datasetSplit"].eq(split)].reset_index(drop=True)
        if sorted(part["target"].unique().tolist()) != [0, 1]:
            raise ValueError(f"SPLIT_MISSING_CLASS:{split}")
        result[split] = {
            "frame": part,
            "x": part[feature_names].to_numpy(dtype=np.float64),
            "y": part["target"].to_numpy(dtype=np.int8),
            "groups": part["matchedCaseId"].astype(str).to_numpy(),
        }
    return result


def probability_metrics(y_true, probabilities):
    return {
        "rocAuc": float(roc_auc_score(y_true, probabilities)),
        "prAuc": float(average_precision_score(y_true, probabilities)),
        "brier": float(brier_score_loss(y_true, probabilities)),
        "logLoss": float(log_loss(y_true, probabilities, labels=[0, 1])),
    }


def prevalence_baselines(splits):
    rows = []
    for name, values in splits.items():
        prevalence = float(values["y"].mean())
        constant = np.full(len(values["y"]), prevalence)
        metrics = probability_metrics(values["y"], constant)
        rows.append({
            "split": name,
            "rows": len(values["y"]),
            "positives": int(values["y"].sum()),
            "prevalence": prevalence,
            "nullPrAuc": prevalence,
            "nullBrier": metrics["brier"],
            "nullLogLoss": metrics["logLoss"],
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Convergencia de estimadores
# ---------------------------------------------------------------------------

def staged_tracking(model: BalancedGradientBoostingClassifier, splits):
    rows = []
    train_stages = model.model_.staged_predict_proba(splits["train"]["x"])
    validation_stages = model.model_.staged_predict_proba(splits["validation"]["x"])
    for stage, (train_p, validation_p) in enumerate(zip(train_stages, validation_stages), 1):
        train_metrics = probability_metrics(splits["train"]["y"], train_p[:, 1])
        validation_metrics = probability_metrics(splits["validation"]["y"], validation_p[:, 1])
        rows.append({
            "iteration": stage,
            **{f"train_{key}": value for key, value in train_metrics.items()},
            **{f"validation_{key}": value for key, value in validation_metrics.items()},
        })
    return pd.DataFrame(rows)


def extended_tracking(splits, max_estimators: int = DEFAULT_MAX_ESTIMATORS, seed: int = 20260927):
    model = BalancedGradientBoostingClassifier(
        **{**DEPLOYED_CONFIG, "n_estimators": max_estimators}, random_state=seed,
    ).fit(splits["train"]["x"], splits["train"]["y"])
    return staged_tracking(model, splits)


def convergence_summary(
    tracking: pd.DataFrame,
    patience: int = DEFAULT_EARLY_STOPPING_PATIENCE,
    min_delta: float = DEFAULT_EARLY_STOPPING_MIN_DELTA,
    grid: Iterable[int] = DEFAULT_ESTIMATOR_GRID,
):
    rule = early_stopping_select(tracking["validation_logLoss"].to_numpy(), patience, min_delta)
    deployed = DEPLOYED_CONFIG["n_estimators"]
    at_deployed = tracking.loc[tracking["iteration"].eq(deployed)]
    best = tracking.loc[tracking["iteration"].eq(rule["absoluteMinimumIteration"])].iloc[0]
    grid_rows = [
        {
            "iteration": int(point),
            "validationLogLoss": float(row["validation_logLoss"]),
            "validationPrAuc": float(row["validation_prAuc"]),
            "trainValidationLogLossGap": float(row["validation_logLoss"] - row["train_logLoss"]),
        }
        for point in grid
        for _, row in tracking.loc[tracking["iteration"].eq(point)].iterrows()
    ]
    return {
        "searchMaximum": int(tracking["iteration"].max()),
        "earlyStoppingRule": rule,
        "absoluteMinimumIteration": rule["absoluteMinimumIteration"],
        "absoluteMinimumIsExploratory": True,
        "absoluteMinimumAtSearchBoundary": rule["absoluteMinimumIteration"] == int(tracking["iteration"].max()),
        "deployedEstimators": deployed,
        "deployedConvergenceDemonstrated": False if at_deployed.empty else bool(
            rule["stoppedEarly"] and rule["bestIteration"] <= deployed
        ),
        "validationLogLossAtDeployed": None if at_deployed.empty else float(at_deployed.iloc[0]["validation_logLoss"]),
        "validationPrAucAtDeployed": None if at_deployed.empty else float(at_deployed.iloc[0]["validation_prAuc"]),
        "validationLogLossAtAbsoluteMinimum": float(best["validation_logLoss"]),
        "validationPrAucAtAbsoluteMinimum": float(best["validation_prAuc"]),
        "estimatorGrid": grid_rows,
    }


def save_tracking_plots(tracking: pd.DataFrame, output_dir: str | Path, convergence: dict | None = None):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    convergence = convergence or convergence_summary(tracking)
    absolute = convergence["absoluteMinimumIteration"]
    rule_best = convergence["earlyStoppingRule"]["bestIteration"]
    deployed = convergence["deployedEstimators"]

    fig, ax = plt.subplots(figsize=(10, 5.8))
    ax.plot(tracking["iteration"], tracking["train_logLoss"], label="Entrenamiento", lw=2.2)
    ax.plot(tracking["iteration"], tracking["validation_logLoss"], label="Validación", lw=2.2)
    if deployed <= tracking["iteration"].max():
        ax.axvline(deployed, color="#7a8793", ls=":", lw=1.8, label=f"Desplegado: {deployed}")
    ax.axvline(rule_best, color="#2a9d8f", ls="-.", lw=1.6, label=f"Regla early stopping: {rule_best}")
    ax.axvline(absolute, color="#e76f51", ls="--", lw=1.6, label=f"Mínimo observado (exploratorio): {absolute}")
    ax.set(title="Convergencia de estimadores (configuración desplegada)", xlabel="Número de estimadores", ylabel="Log loss")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "estimator_convergence.png", dpi=300, bbox_inches="tight")
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, metric, title in ((axes[0], "rocAuc", "ROC-AUC"), (axes[1], "prAuc", "PR-AUC")):
        ax.plot(tracking["iteration"], tracking[f"train_{metric}"], label="Entrenamiento", lw=2.1)
        ax.plot(tracking["iteration"], tracking[f"validation_{metric}"], label="Validación", lw=2.1)
        if deployed <= tracking["iteration"].max():
            ax.axvline(deployed, color="#7a8793", ls=":", lw=1.4)
        ax.set(title=title, xlabel="Número de estimadores", ylabel=title)
        ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "train_validation_scores_v2.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return absolute


# ---------------------------------------------------------------------------
# Curvas agrupadas
# ---------------------------------------------------------------------------

def _development(frame, feature_names):
    development = frame.loc[frame["datasetSplit"].isin(["train", "validation"])].copy()
    return (
        development[feature_names].to_numpy(dtype=np.float64),
        development["target"].to_numpy(dtype=np.int8),
        development["matchedCaseId"].astype(str).to_numpy(),
    )


def group_learning_curve(frame, feature_names, output_dir, train_sizes: Iterable[float] = (0.2, 0.4, 0.6, 0.8, 1.0)):
    x, y, groups = _development(frame, feature_names)
    sizes, train_scores, validation_scores = learning_curve(
        BalancedGradientBoostingClassifier(), x, y, groups=groups,
        cv=GroupKFold(n_splits=5), scoring="average_precision",
        train_sizes=np.asarray(list(train_sizes)), n_jobs=-1,
    )
    result = pd.DataFrame({
        "trainSize": sizes,
        "trainMean": train_scores.mean(axis=1), "trainStd": train_scores.std(axis=1),
        "validationMean": validation_scores.mean(axis=1), "validationStd": validation_scores.std(axis=1),
    })
    result["gap"] = result["trainMean"] - result["validationMean"]
    output_dir = Path(output_dir)
    result.to_csv(output_dir / "learning_curve_metrics_v2.csv", index=False)
    fig, ax = plt.subplots(figsize=(9.5, 5.6))
    ax.plot(sizes, result["trainMean"], marker="o", lw=2.2, label="Entrenamiento")
    ax.plot(sizes, result["validationMean"], marker="o", lw=2.2, label="Validación")
    ax.fill_between(sizes, result["trainMean"] - result["trainStd"], result["trainMean"] + result["trainStd"], alpha=.16)
    ax.fill_between(sizes, result["validationMean"] - result["validationStd"], result["validationMean"] + result["validationStd"], alpha=.16)
    for index in (0, len(result) - 1):
        row = result.iloc[index]
        ax.annotate(f"gap={row['gap']:.3f}", (row["trainSize"], (row["trainMean"] + row["validationMean"]) / 2),
                    xytext=(8, 0), textcoords="offset points", fontsize=9, color="#b34d2e")
    ax.set(title="Learning curve agrupada por matchedCaseId", xlabel="Filas de entrenamiento", ylabel="PR-AUC")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "learning_curve_pr_auc_v2.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return result


def depth_validation_curve(frame, feature_names, output_dir):
    x, y, groups = _development(frame, feature_names)
    depths = np.asarray([1, 2, 3, 4])
    train_scores, validation_scores = validation_curve(
        BalancedGradientBoostingClassifier(), x, y, groups=groups,
        param_name="max_depth", param_range=depths, cv=GroupKFold(n_splits=5),
        scoring="average_precision", n_jobs=-1,
    )
    result = pd.DataFrame({
        "maxDepth": depths,
        "trainMean": train_scores.mean(axis=1), "trainStd": train_scores.std(axis=1),
        "validationMean": validation_scores.mean(axis=1), "validationStd": validation_scores.std(axis=1),
    })
    result["gap"] = result["trainMean"] - result["validationMean"]
    output_dir = Path(output_dir)
    result.to_csv(output_dir / "validation_curve_depth_metrics_v2.csv", index=False)
    fig, ax = plt.subplots(figsize=(9.5, 5.6))
    ax.errorbar(depths, result["trainMean"], yerr=result["trainStd"], marker="o", lw=2.2, capsize=4, label="Entrenamiento")
    ax.errorbar(depths, result["validationMean"], yerr=result["validationStd"], marker="o", lw=2.2, capsize=4, label="Validación")
    ax.set(title="Validation curve - profundidad del árbol", xlabel="max_depth", ylabel="PR-AUC", xticks=depths)
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "validation_curve_depth_v2.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return result


# ---------------------------------------------------------------------------
# Experimentos de regularización
# ---------------------------------------------------------------------------

def _fit_experiment(experiment, splits, seed):
    model = BalancedGradientBoostingClassifier(
        max_depth=experiment.max_depth,
        min_samples_leaf=experiment.min_samples_leaf,
        subsample=experiment.subsample,
        random_state=seed,
    ).fit(splits["train"]["x"], splits["train"]["y"])
    return {name: model.predict_proba(values["x"])[:, 1] for name, values in splits.items()}


def repeated_seed_experiment(splits, seed_count: int, base_seed: int, deterministic_single_seed: bool = False):
    """Entrena cada experimento con varias semillas usando solo train.

    Las configuraciones con subsample < 1 son estocásticas y siempre usan
    todas las semillas. Las deterministas pueden reducirse a una semilla con
    ``deterministic_single_seed``; por defecto se repiten para uniformidad.
    """
    seeds = seed_schedule(base_seed, seed_count)
    rows = []
    store = {item.key: {split: [] for split in splits if split != "train"} for item in REGULARIZATION_EXPERIMENTS}
    for experiment in REGULARIZATION_EXPERIMENTS:
        experiment_seeds = seeds if (experiment.stochastic or not deterministic_single_seed) else seeds[:1]
        for seed in experiment_seeds:
            predictions = _fit_experiment(experiment, splits, seed)
            record = {
                "key": experiment.key, "strategy": experiment.name, "seed": seed,
                "max_depth": experiment.max_depth,
                "min_samples_leaf": experiment.min_samples_leaf,
                "subsample": experiment.subsample,
            }
            for split in ("train", "validation"):
                metrics = probability_metrics(splits[split]["y"], predictions[split])
                record.update({f"{split}_{key}": value for key, value in metrics.items()})
            record["prAucGapTrainValidation"] = record["train_prAuc"] - record["validation_prAuc"]
            rows.append(record)
            for split in store[experiment.key]:
                store[experiment.key][split].append(predictions[split])
    raw = pd.DataFrame(rows)
    summary_rows = []
    for experiment in REGULARIZATION_EXPERIMENTS:
        part = raw.loc[raw["key"].eq(experiment.key)]
        row = {
            "key": experiment.key, "strategy": experiment.name,
            "max_depth": experiment.max_depth,
            "min_samples_leaf": experiment.min_samples_leaf,
            "subsample": experiment.subsample,
            "stochastic": experiment.stochastic,
            "seedsEvaluated": int(len(part)),
        }
        for metric in ("validation_prAuc", "validation_rocAuc", "validation_logLoss", "prAucGapTrainValidation"):
            values = part[metric].to_numpy()
            row[f"{metric}_mean"] = float(values.mean())
            row[f"{metric}_std"] = float(values.std(ddof=1)) if len(values) > 1 else 0.0
            row[f"{metric}_lower95Seeds"] = float(np.quantile(values, 0.025))
            row[f"{metric}_upper95Seeds"] = float(np.quantile(values, 0.975))
        summary_rows.append(row)
    ensemble = {
        key: {split: np.mean(np.stack(values), axis=0) for split, values in by_split.items()}
        for key, by_split in store.items()
    }
    return raw, pd.DataFrame(summary_rows), ensemble


def validation_thresholds(splits, ensemble, maximum_fpr=0.05):
    """Umbral por estrategia con FPR <= máximo en validación (optimista)."""
    y = splits["validation"]["y"]
    thresholds = {}
    for key, predictions in ensemble.items():
        probabilities = predictions["validation"]
        best = (-1.0, 1.0)
        for threshold in np.unique(probabilities):
            predicted = probabilities >= threshold
            fp = np.sum(predicted & (y == 0))
            tn = np.sum(~predicted & (y == 0))
            if fp / max(fp + tn, 1) <= maximum_fpr:
                recall = np.sum(predicted & (y == 1)) / max(np.sum(y == 1), 1)
                if recall > best[0] or (recall == best[0] and threshold > best[1]):
                    best = (float(recall), float(threshold))
        thresholds[key] = best[1]
    return thresholds


def compare_strategies(splits, output_dir, seeds: int = 1, base_seed: int = 20260927):
    """Compatibilidad con el notebook original: resumen por estrategia."""
    _, summary, _ = repeated_seed_experiment(splits, seeds, base_seed)
    output_dir = Path(output_dir)
    summary.to_csv(output_dir / "strategy_comparison.csv", index=False)
    return summary


def bootstrap_table(bootstrap: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    names = {item.key: item.name for item in REGULARIZATION_EXPERIMENTS}
    rows = []
    for key, metrics in bootstrap["intervals"].items():
        for metric, values in metrics.items():
            rows.append({"key": key, "strategy": names[key], "metric": metric, **values})
    difference_rows = []
    for key, metrics in bootstrap["pairedDifferences"].items():
        for metric, values in metrics.items():
            difference_rows.append({
                "key": key, "strategy": names[key], "reference": bootstrap["reference"],
                "metric": metric, **values,
            })
    return pd.DataFrame(rows), pd.DataFrame(difference_rows)


def save_strategy_plot(bootstrap: dict, validation_prevalence: float, output_dir: Path):
    keys = [item.key for item in REGULARIZATION_EXPERIMENTS]
    labels = ["Base\ncompleja", "Stumps", "Solo\nleaf", "Solo\nsubsample", "Combinada\n(desplegada)"]
    intervals = [bootstrap["intervals"][key]["prAuc"] for key in keys]
    point = np.asarray([item["point"] for item in intervals])
    lower = point - np.asarray([item["lower95"] for item in intervals])
    upper = np.asarray([item["upper95"] for item in intervals]) - point
    x = np.arange(len(keys))
    fig, ax = plt.subplots(figsize=(10.5, 5.8))
    bars = ax.bar(x, point, color=["#385170", "#4e8fa8", "#54b399", "#e0a458", "#d1603d"], alpha=.88)
    ax.errorbar(x, point, yerr=np.vstack([lower, upper]), fmt="none", ecolor="#17212b", capsize=5, lw=1.4)
    for bar, value in zip(bars, point):
        ax.text(bar.get_x() + bar.get_width() / 2, value + .012, f"{value:.3f}", ha="center", va="bottom", fontsize=9, fontweight="bold")
    ax.axhline(validation_prevalence, color="#7a8793", ls="--", lw=1.3, label=f"Línea base nula = prevalencia ({validation_prevalence:.4f})")
    ax.set_xticks(x, labels)
    ax.set_ylim(max(0, validation_prevalence - .05), 1.06)
    ax.set(title="PR-AUC de validación con IC bootstrap agrupado del 95 %", ylabel="PR-AUC")
    ax.legend(loc="lower right")
    fig.tight_layout()
    fig.savefig(output_dir / "strategy_validation_bootstrap.png", dpi=300, bbox_inches="tight")
    plt.close(fig)


# ---------------------------------------------------------------------------
# Diagnóstico
# ---------------------------------------------------------------------------

def quantitative_diagnosis(
    tracking: pd.DataFrame,
    strategies: pd.DataFrame,
    validation_prevalence: float | None = None,
    pr_auc_interval: dict | None = None,
    min_lift: float = DEFAULT_MIN_PR_AUC_LIFT,
    reference_key: str = DEPLOYED_EXPERIMENT_KEY,
):
    """Diagnóstico de la configuración de referencia (por defecto, la desplegada).

    Subajuste: el IC 95 % de PR-AUC no demuestra una mejora material sobre la
    prevalencia. Ya no se usa ``validation_pr_auc < 0.50``.
    """
    if "key" in strategies.columns:
        final = strategies.loc[strategies["key"].eq(reference_key)].iloc[0]
    else:
        final = strategies.iloc[-1]
    pr_column = "validation_prAuc_mean" if "validation_prAuc_mean" in strategies.columns else "validation_prAuc"
    gap_column = "prAucGapTrainValidation_mean" if "prAucGapTrainValidation_mean" in strategies.columns else "prAucGapTrainValidation"
    pr_auc = float(final[pr_column])
    pr_gap = float(final[gap_column])
    best_row = tracking.loc[tracking["validation_logLoss"].idxmin()]
    loss_gap = float(best_row["validation_logLoss"] - best_row["train_logLoss"])
    if validation_prevalence is None:
        raise ValueError("VALIDATION_PREVALENCE_REQUIRED_FOR_NULL_BASELINE")
    lift = pr_auc_lift_assessment(pr_auc, pr_auc_interval, validation_prevalence, min_lift)
    overfitting = pr_gap > 0.10 or loss_gap > 0.10
    underfitting = bool(lift["possibleUnderfitting"])
    if overfitting:
        label = "RIESGO_DE_OVERFITTING"
    elif underfitting:
        label = "POSIBLE_UNDERFITTING"
    else:
        label = "GENERALIZACION_ADECUADA"
    return {
        "diagnosis": label,
        "referenceStrategy": str(final.get("strategy", reference_key)),
        "overfittingSignal": bool(overfitting),
        "underfittingSignal": underfitting,
        "trainValidationPrAucGap": pr_gap,
        "trainValidationLogLossGapAtAbsoluteMinimum": loss_gap,
        "validationPrAuc": pr_auc,
        "prAucLiftOverPrevalence": lift,
        "underfittingRule": "Posible subajuste si el límite inferior del IC 95 % de PR-AUC no supera la prevalencia en al menos minimumMaterialLift.",
        "note": "Regla académica orientativa; la interpretación final debe considerar todas las curvas.",
    }


def select_by_validation(seed_summary: pd.DataFrame, bootstrap: dict, reference_key: str = DEPLOYED_EXPERIMENT_KEY):
    """Regla predefinida: mayor PR-AUC medio de validación; desempate por log loss.

    Se declara ganadora solo si su diferencia pareada con la referencia excluye cero.
    """
    ordered = seed_summary.sort_values(
        ["validation_prAuc_mean", "validation_logLoss_mean"], ascending=[False, True],
    )
    top_key = str(ordered.iloc[0]["key"])
    if top_key == reference_key:
        superior = False
        difference = None
    else:
        difference = bootstrap["pairedDifferences"][top_key]["prAuc"]
        superior = not difference["includesZero"] and difference["lower95"] > 0
    return {
        "rule": "max validation_prAuc_mean, tie-break min validation_logLoss_mean",
        "topByValidation": top_key,
        "reference": reference_key,
        "topMinusReferencePrAuc95": difference,
        "statisticallySuperiorToReference": bool(superior),
        "conclusion": (
            f"{top_key} supera a {reference_key} en validación con IC que excluye cero"
            if superior else
            "No existe una estrategia estadísticamente superior a la referencia con la muestra actual"
        ),
        "testUsed": False,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(description="Diagnóstico de overfitting/underfitting de TronSentinel")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--plots-dir")
    parser.add_argument("--seeds", type=int, default=ACADEMIC_SEED_COUNT, help="30 académico, 10 rápido")
    parser.add_argument("--deterministic-single-seed", action="store_true")
    parser.add_argument("--bootstrap", type=int, default=ACADEMIC_BOOTSTRAP_REPETITIONS)
    parser.add_argument("--max-estimators", type=int, default=DEFAULT_MAX_ESTIMATORS)
    parser.add_argument("--early-stopping-patience", type=int, default=DEFAULT_EARLY_STOPPING_PATIENCE)
    parser.add_argument("--early-stopping-min-delta", type=float, default=DEFAULT_EARLY_STOPPING_MIN_DELTA)
    parser.add_argument("--min-pr-auc-lift", type=float, default=DEFAULT_MIN_PR_AUC_LIFT)
    parser.add_argument("--skip-curves", action="store_true", help="Omite learning/validation curves (más rápido)")
    parser.add_argument("--include-test", action="store_true", help="Consulta test tras fijar la selección; usa el ledger")
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    parser.add_argument("--seed", type=int, default=20260927)
    return parser.parse_args()


def main():
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    frame, manifest, feature_names = load_development_dataset(args.dataset, args.manifest)
    dataset_hash = sha256_file(args.dataset)
    splits = split_arrays(frame, feature_names, include_test=args.include_test)
    selection_splits = {name: values for name, values in splits.items() if name != "test"}

    prevalence_baselines(splits).to_csv(output_dir / "prevalence_baselines.csv", index=False)
    validation_prevalence = float(splits["validation"]["y"].mean())

    tracking = extended_tracking(selection_splits, args.max_estimators, args.seed)
    tracking.to_csv(output_dir / "tracking_metrics_extended.csv", index=False)
    convergence = convergence_summary(tracking, args.early_stopping_patience, args.early_stopping_min_delta)
    save_tracking_plots(tracking, output_dir, convergence)

    if not args.skip_curves:
        group_learning_curve(frame, feature_names, output_dir)
        depth_validation_curve(frame, feature_names, output_dir)

    seed_raw, seed_summary, ensemble = repeated_seed_experiment(
        splits, args.seeds, args.seed, args.deterministic_single_seed,
    )
    seed_raw.to_csv(output_dir / "strategy_seed_runs.csv", index=False)
    seed_summary.to_csv(output_dir / "strategy_seed_summary.csv", index=False)

    thresholds = validation_thresholds(splits, ensemble)
    validation_bootstrap = grouped_bootstrap(
        splits["validation"]["y"], splits["validation"]["groups"],
        {key: values["validation"] for key, values in ensemble.items()},
        thresholds=thresholds, repetitions=args.bootstrap, seed=args.seed + 1,
        reference=DEPLOYED_EXPERIMENT_KEY,
    )
    intervals, differences = bootstrap_table(validation_bootstrap)
    intervals.to_csv(output_dir / "strategy_validation_bootstrap_summary.csv", index=False)
    differences.to_csv(output_dir / "strategy_validation_bootstrap_differences_vs_deployed.csv", index=False)
    save_strategy_plot(validation_bootstrap, validation_prevalence, output_dir)

    selection = select_by_validation(seed_summary, validation_bootstrap)
    diagnosis = quantitative_diagnosis(
        tracking, seed_summary, validation_prevalence,
        validation_bootstrap["intervals"][DEPLOYED_EXPERIMENT_KEY]["prAuc"], args.min_pr_auc_lift,
    )

    test_section = {"opened": False, "reason": "Test sellado; usar --include-test solo para confirmación"}
    if args.include_test:
        ledger = load_ledger(args.ledger)
        previous = find_openings(ledger, dataset_hash, "internal-test")
        if previous:
            status = "CONSUMED_REPORT_ONLY"
        else:
            record_opening(args.ledger, {
                "partition": "internal-test", "datasetHash": dataset_hash,
                "openedFor": f"diagnose_overfitting:{selection['topByValidation']}",
                "purpose": "Confirmación académica posterior a la selección por validación",
                "openedBy": "diagnose_overfitting.py",
            })
            status = "OPENED_NOW_CONFIRMATORY"
        test_bootstrap = grouped_bootstrap(
            splits["test"]["y"], splits["test"]["groups"],
            {key: values["test"] for key, values in ensemble.items()},
            thresholds=thresholds, repetitions=args.bootstrap, seed=args.seed + 2,
            reference=DEPLOYED_EXPERIMENT_KEY,
        )
        test_intervals, test_differences = bootstrap_table(test_bootstrap)
        test_intervals.to_csv(output_dir / "strategy_test_bootstrap_summary.csv", index=False)
        test_differences.to_csv(output_dir / "strategy_test_bootstrap_differences_vs_deployed.csv", index=False)
        test_section = {
            "opened": True,
            "status": status,
            "selectionFixedBeforeOpening": selection["topByValidation"],
            "nullPrAuc": float(splits["test"]["y"].mean()),
            "selectedStrategyPrAuc95": test_bootstrap["intervals"][selection["topByValidation"]]["prAuc"],
            "rule": "El test no puede cambiar la selección ni el modelo desplegado.",
        }

    result = {
        "diagnosisFramework": "validation_for_selection_test_for_confirmation",
        "nullPrAucPolicy": "PR-AUC nulo igual a prevalencia de la partición",
        "datasetHash": dataset_hash,
        "validationNullPrAuc": validation_prevalence,
        "experiments": experiments_as_dicts(),
        "seeds": args.seeds,
        "bootstrapRepetitions": args.bootstrap,
        "convergence": convergence,
        "selection": selection,
        "diagnosis": diagnosis,
        "thresholdMetricsNote": "Recall y FPR usan umbrales elegidos en la misma validación (FPR <= 5 %); son optimistas y solo comparativos.",
        "test": test_section,
        "deployedModelChanged": False,
        "externalHoldoutUsed": False,
    }
    (output_dir / "diagnosis_v2.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    plots_dir = Path(args.plots_dir).resolve() if args.plots_dir else output_dir
    plots_dir.mkdir(parents=True, exist_ok=True)
    for filename in output_dir.glob("*.png"):
        destination = plots_dir / filename.name
        if filename.resolve() != destination.resolve():
            shutil.copy2(filename, destination)
    print(json.dumps({key: result[key] for key in ("selection", "diagnosis", "test")}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
