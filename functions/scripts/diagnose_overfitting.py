#!/usr/bin/env python3
"""Herramientas modulares para el diagnóstico de overfitting de TronSentinel.

El módulo no modifica el modelo desplegado ni consulta el holdout externo.
Trabaja exclusivamente con las particiones de desarrollo ya congeladas.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold, learning_curve, validation_curve


META_COLUMNS = {
    "cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target",
}


class BalancedGradientBoostingClassifier(ClassifierMixin, BaseEstimator):
    """Gradient Boosting que calcula pesos balanceados dentro de cada fit.

    El wrapper permite usar learning_curve y validation_curve sin perder la
    política de ponderación aplicada por el entrenamiento productivo.
    """

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
        weights = np.where(
            y == 1,
            len(y) / (2.0 * positives),
            len(y) / (2.0 * controls),
        )
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


def load_development_dataset(dataset_path: str | Path, manifest_path: str | Path):
    dataset_path = Path(dataset_path).expanduser().resolve()
    manifest_path = Path(manifest_path).expanduser().resolve()
    frame = pd.read_csv(dataset_path, low_memory=False)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    feature_names = [name for name in frame.columns if name not in META_COLUMNS]
    if feature_names != manifest["featureNames"]:
        raise ValueError("FEATURE_ORDER_DIFFERS_FROM_MANIFEST")
    if frame[feature_names].isna().any().any():
        raise ValueError("FEATURES_CONTAIN_NULLS")
    values = frame[feature_names].to_numpy(dtype=np.float64)
    if not np.isfinite(values).all():
        raise ValueError("FEATURES_CONTAIN_NON_FINITE_VALUES")
    group_splits = frame.groupby("matchedCaseId")["datasetSplit"].nunique()
    if (group_splits != 1).any():
        raise ValueError("MATCHED_GROUP_CROSSES_SPLITS")
    return frame, manifest, feature_names


def split_arrays(frame: pd.DataFrame, feature_names: list[str]):
    result = {}
    for split in ("train", "validation", "test"):
        part = frame.loc[frame["datasetSplit"].eq(split)].copy()
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


def staged_tracking(model: BalancedGradientBoostingClassifier, splits):
    rows = []
    train_stages = model.model_.staged_predict_proba(splits["train"]["x"])
    validation_stages = model.model_.staged_predict_proba(splits["validation"]["x"])
    for stage, (train_p, validation_p) in enumerate(zip(train_stages, validation_stages), 1):
        train_prob = train_p[:, 1]
        validation_prob = validation_p[:, 1]
        train_metrics = probability_metrics(splits["train"]["y"], train_prob)
        validation_metrics = probability_metrics(splits["validation"]["y"], validation_prob)
        rows.append({
            "iteration": stage,
            **{f"train_{key}": value for key, value in train_metrics.items()},
            **{f"validation_{key}": value for key, value in validation_metrics.items()},
        })
    return pd.DataFrame(rows)


def save_tracking_plots(tracking: pd.DataFrame, output_dir: str | Path):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    plt.style.use("seaborn-v0_8-whitegrid")

    best_iteration = int(tracking.loc[tracking["validation_logLoss"].idxmin(), "iteration"])
    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(tracking["iteration"], tracking["train_logLoss"], label="Entrenamiento", lw=2.2)
    ax.plot(tracking["iteration"], tracking["validation_logLoss"], label="Validación", lw=2.2)
    ax.axvline(best_iteration, color="#e76f51", ls="--", label=f"Mejor iteración: {best_iteration}")
    ax.set(title="TronSentinel - pérdida durante el entrenamiento", xlabel="Número de estimadores", ylabel="Log loss")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "train_validation_loss.png", dpi=300, bbox_inches="tight")
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for ax, metric, title in (
        (axes[0], "rocAuc", "ROC-AUC"),
        (axes[1], "prAuc", "PR-AUC"),
    ):
        ax.plot(tracking["iteration"], tracking[f"train_{metric}"], label="Entrenamiento", lw=2.2)
        ax.plot(tracking["iteration"], tracking[f"validation_{metric}"], label="Validación", lw=2.2)
        ax.set(title=f"Evolución de {title}", xlabel="Número de estimadores", ylabel=title)
        ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "train_validation_scores.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return best_iteration


def group_learning_curve(
    frame: pd.DataFrame,
    feature_names: list[str],
    output_dir: str | Path,
    train_sizes: Iterable[float] = (0.2, 0.4, 0.6, 0.8, 1.0),
):
    development = frame.loc[frame["datasetSplit"].isin(["train", "validation"])].copy()
    x = development[feature_names].to_numpy(dtype=np.float64)
    y = development["target"].to_numpy(dtype=np.int8)
    groups = development["matchedCaseId"].astype(str).to_numpy()
    estimator = BalancedGradientBoostingClassifier()
    sizes, train_scores, validation_scores = learning_curve(
        estimator,
        x,
        y,
        groups=groups,
        cv=GroupKFold(n_splits=5),
        scoring="average_precision",
        train_sizes=np.asarray(list(train_sizes)),
        shuffle=False,
        n_jobs=-1,
    )
    result = pd.DataFrame({
        "trainSize": sizes,
        "trainMean": train_scores.mean(axis=1),
        "trainStd": train_scores.std(axis=1),
        "validationMean": validation_scores.mean(axis=1),
        "validationStd": validation_scores.std(axis=1),
    })
    output_dir = Path(output_dir)
    result.to_csv(output_dir / "learning_curve_metrics.csv", index=False)
    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(sizes, result["trainMean"], marker="o", lw=2.2, label="Entrenamiento")
    ax.plot(sizes, result["validationMean"], marker="o", lw=2.2, label="Validación")
    ax.fill_between(sizes, result["trainMean"] - result["trainStd"], result["trainMean"] + result["trainStd"], alpha=0.18)
    ax.fill_between(sizes, result["validationMean"] - result["validationStd"], result["validationMean"] + result["validationStd"], alpha=0.18)
    ax.set(title="Learning curve agrupada por matchedCaseId", xlabel="Filas utilizadas para entrenamiento", ylabel="PR-AUC")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "learning_curve_pr_auc.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return result


def depth_validation_curve(frame: pd.DataFrame, feature_names: list[str], output_dir: str | Path):
    development = frame.loc[frame["datasetSplit"].isin(["train", "validation"])].copy()
    x = development[feature_names].to_numpy(dtype=np.float64)
    y = development["target"].to_numpy(dtype=np.int8)
    groups = development["matchedCaseId"].astype(str).to_numpy()
    depths = np.asarray([1, 2, 3, 4])
    train_scores, validation_scores = validation_curve(
        BalancedGradientBoostingClassifier(),
        x,
        y,
        groups=groups,
        param_name="max_depth",
        param_range=depths,
        cv=GroupKFold(n_splits=5),
        scoring="average_precision",
        n_jobs=-1,
    )
    result = pd.DataFrame({
        "maxDepth": depths,
        "trainMean": train_scores.mean(axis=1),
        "trainStd": train_scores.std(axis=1),
        "validationMean": validation_scores.mean(axis=1),
        "validationStd": validation_scores.std(axis=1),
    })
    output_dir = Path(output_dir)
    result.to_csv(output_dir / "validation_curve_depth_metrics.csv", index=False)
    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(depths, result["trainMean"], marker="o", lw=2.2, label="Entrenamiento")
    ax.plot(depths, result["validationMean"], marker="o", lw=2.2, label="Validación")
    ax.set(title="Validation curve - profundidad del árbol", xlabel="max_depth", ylabel="PR-AUC", xticks=depths)
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "validation_curve_depth.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return result


def compare_strategies(splits, output_dir: str | Path):
    configurations = {
        "Base compleja": dict(max_depth=3, min_samples_leaf=1, subsample=1.0),
        "Estrategia 1 - menor complejidad": dict(max_depth=1, min_samples_leaf=1, subsample=1.0),
        "Estrategia 2 - modelo regularizado": dict(max_depth=1, min_samples_leaf=20, subsample=0.8),
    }
    rows = []
    for name, parameters in configurations.items():
        model = BalancedGradientBoostingClassifier(**parameters)
        model.fit(splits["train"]["x"], splits["train"]["y"])
        metrics = {}
        for split in ("train", "validation", "test"):
            probabilities = model.predict_proba(splits[split]["x"])[:, 1]
            values = probability_metrics(splits[split]["y"], probabilities)
            metrics.update({f"{split}_{key}": value for key, value in values.items()})
        rows.append({"strategy": name, **parameters, **metrics})
    result = pd.DataFrame(rows)
    result["prAucGapTrainValidation"] = result["train_prAuc"] - result["validation_prAuc"]
    result["prAucGapTrainTest"] = result["train_prAuc"] - result["test_prAuc"]
    output_dir = Path(output_dir)
    result.to_csv(output_dir / "strategy_comparison.csv", index=False)

    fig, ax = plt.subplots(figsize=(11, 5.5))
    positions = np.arange(len(result))
    width = 0.25
    for offset, split in ((-width, "train"), (0, "validation"), (width, "test")):
        ax.bar(positions + offset, result[f"{split}_prAuc"], width, label=split.capitalize())
    ax.set_xticks(positions, ["Base", "Menor complejidad", "Regularizado"])
    ax.set_ylim(0, 1.05)
    ax.set(title="Comparación antes y después de las estrategias", ylabel="PR-AUC")
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "strategies_comparison.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    return result


def quantitative_diagnosis(tracking: pd.DataFrame, strategies: pd.DataFrame):
    final = strategies.loc[strategies["strategy"].eq("Estrategia 2 - modelo regularizado")].iloc[0]
    best_row = tracking.loc[tracking["validation_logLoss"].idxmin()]
    pr_gap = float(final["prAucGapTrainValidation"])
    loss_gap = float(best_row["validation_logLoss"] - best_row["train_logLoss"])
    if pr_gap > 0.10 or loss_gap > 0.10:
        label = "RIESGO_DE_OVERFITTING"
    elif float(final["validation_prAuc"]) < 0.50 and abs(pr_gap) < 0.05:
        label = "POSIBLE_UNDERFITTING"
    else:
        label = "GENERALIZACION_ADECUADA"
    return {
        "diagnosis": label,
        "bestIterationByValidationLogLoss": int(best_row["iteration"]),
        "trainValidationPrAucGap": pr_gap,
        "trainValidationLogLossGapAtBestIteration": loss_gap,
        "validationPrAuc": float(final["validation_prAuc"]),
        "testPrAuc": float(final["test_prAuc"]),
        "note": "Regla académica orientativa; la interpretación final debe considerar todas las curvas.",
    }

