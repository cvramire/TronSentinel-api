#!/usr/bin/env python3
"""Entrena un challenger on-chain de TronSentinel.

Política de gobernanza (ver docs/TRAINING_GOVERNANCE.md):

- La selección de estimadores, la calibración y el umbral usan solo validación.
- El test interno permanece sellado: este script no lo calcula. Se abre una
  única vez con ``confirm-onchain-test.py`` después de congelar el candidato.
- El número de estimadores se elige con una regla de early stopping externa y
  predefinida sobre ``staged_predict_proba`` (no con el early stopping interno
  aleatorio de scikit-learn, incompatible con el diseño cronológico agrupado).
- ``--estimator-selection fixed --estimators 150`` reproduce v0.6.1.
"""

import argparse
import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    log_loss,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
)

from onchain_governance import (
    DEFAULT_BOOTSTRAP_REPETITIONS,
    DEFAULT_EARLY_STOPPING_MIN_DELTA,
    DEFAULT_EARLY_STOPPING_PATIENCE,
    DEFAULT_ESTIMATOR_GRID,
    DEFAULT_MAX_ESTIMATORS,
    DEFAULT_MIN_PR_AUC_LIFT,
    QUICK_SEED_COUNT,
    early_stopping_select,
    grouped_bootstrap,
    null_pr_auc,
    parse_int_grid,
    pr_auc_lift_assessment,
    seed_schedule,
    sha256_file,
)


META_COLUMNS = {"cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target"}
FORBIDDEN_FEATURE_TOKENS = ("blacklist", "blocklist", "label", "riskscore", "risklevel")
# El scorer TypeScript exporta exclusivamente stumps.
EXPORTABLE_MAX_DEPTH = 1


def parse_args():
    parser = argparse.ArgumentParser(description="Entrena el challenger on-chain de TronSentinel")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-version", required=True)
    parser.add_argument(
        "--estimator-selection",
        choices=("early-stopping", "fixed"),
        default="early-stopping",
        help="early-stopping para nuevos candidatos; fixed solo para reproducir versiones previas",
    )
    parser.add_argument("--estimators", type=int, default=150, help="Usado solo con --estimator-selection fixed")
    parser.add_argument("--max-estimators", type=int, default=DEFAULT_MAX_ESTIMATORS)
    parser.add_argument(
        "--estimator-grid",
        default=",".join(str(value) for value in DEFAULT_ESTIMATOR_GRID),
        help="Puntos de la búsqueda que se reportan en validación (no seleccionan por sí mismos)",
    )
    parser.add_argument("--early-stopping-patience", type=int, default=DEFAULT_EARLY_STOPPING_PATIENCE)
    parser.add_argument("--early-stopping-min-delta", type=float, default=DEFAULT_EARLY_STOPPING_MIN_DELTA)
    parser.add_argument("--learning-rate", type=float, default=0.04)
    parser.add_argument("--min-samples-leaf", type=int, default=20)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--seed", type=int, default=20260927)
    parser.add_argument(
        "--stability-seeds",
        type=int,
        default=QUICK_SEED_COUNT,
        help="Semillas adicionales para medir la estabilidad del early stopping cuando subsample < 1 (0 desactiva)",
    )
    parser.add_argument("--bootstrap", type=int, default=DEFAULT_BOOTSTRAP_REPETITIONS)
    parser.add_argument("--min-pr-auc-lift", type=float, default=DEFAULT_MIN_PR_AUC_LIFT)
    parser.add_argument(
        "--max-validation-fpr",
        type=float,
        default=0.05,
        help="FPR máximo usado únicamente para seleccionar el umbral en validación",
    )
    return parser.parse_args()


def sigmoid(value):
    value = np.clip(value, -40, 40)
    return 1.0 / (1.0 + np.exp(-value))


def metrics_at(y_true, probabilities, threshold):
    predicted = (probabilities >= threshold).astype(np.int8)
    tn, fp, fn, tp = confusion_matrix(y_true, predicted, labels=[0, 1]).ravel()
    precision = precision_score(y_true, predicted, zero_division=0)
    recall = recall_score(y_true, predicted, zero_division=0)
    return {
        "threshold": float(threshold),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(2 * precision * recall / max(precision + recall, 1e-15)),
        "falsePositiveRate": float(fp / max(fp + tn, 1)),
        "confusionMatrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def choose_recall_threshold(y_true, probabilities):
    precision, recall, thresholds = precision_recall_curve(y_true, probabilities)
    if not len(thresholds):
        raise ValueError("VALIDATION_THRESHOLDS_EMPTY")
    p, r = precision[:-1], recall[:-1]
    f2 = 5 * p * r / np.maximum(4 * p + r, 1e-15)
    return float(thresholds[int(np.nanargmax(f2))])


def choose_controlled_fpr_threshold(y_true, probabilities, maximum_fpr=0.10):
    candidates = np.unique(probabilities)
    eligible = []
    for threshold in candidates:
        item = metrics_at(y_true, probabilities, float(threshold))
        if item["falsePositiveRate"] <= maximum_fpr:
            eligible.append(item)
    if not eligible:
        return 1.0
    best = max(eligible, key=lambda item: (item["recall"], item["precision"], -item["threshold"]))
    return float(best["threshold"])


def split_report(y_true, probabilities, recall_threshold, controlled_threshold):
    return {
        "rows": int(len(y_true)),
        "positives": int(np.sum(y_true)),
        "controls": int(len(y_true) - np.sum(y_true)),
        "samplePrevalence": float(np.mean(y_true)),
        "nullPrAuc": null_pr_auc(y_true),
        "prAuc": float(average_precision_score(y_true, probabilities)),
        "rocAuc": float(roc_auc_score(y_true, probabilities)),
        "brier": float(brier_score_loss(y_true, probabilities)),
        "recallFirstOperatingPoint": metrics_at(y_true, probabilities, recall_threshold),
        "controlledFprOperatingPoint": metrics_at(y_true, probabilities, controlled_threshold),
    }


def export_stumps(classifier, feature_names):
    result = []
    for estimator in classifier.estimators_[:, 0]:
        tree = estimator.tree_
        if tree.node_count != 3:
            raise ValueError("MODEL_IS_NOT_A_DECISION_STUMP")
        feature_index = int(tree.feature[0])
        result.append({
            "feature": feature_names[feature_index],
            "threshold": float(tree.threshold[0]),
            "leftValue": float(tree.value[1][0][0]),
            "rightValue": float(tree.value[2][0][0]),
        })
    return result


def score_export(model, feature):
    raw = model["baseLogit"]
    for stump in model["stumps"]:
        value = stump["leftValue"] if feature[stump["feature"]] <= stump["threshold"] else stump["rightValue"]
        raw += model["learningRate"] * value
    return float(sigmoid(model["calibrator"]["a"] * raw + model["calibrator"]["b"]))


def build_classifier(args, n_estimators, seed):
    return GradientBoostingClassifier(
        n_estimators=n_estimators,
        learning_rate=args.learning_rate,
        max_depth=EXPORTABLE_MAX_DEPTH,
        min_samples_leaf=args.min_samples_leaf,
        subsample=args.subsample,
        random_state=seed,
    )


def staged_validation_curve(classifier, x_validation, y_validation):
    rows = []
    for iteration, probabilities in enumerate(classifier.staged_predict_proba(x_validation), 1):
        p = probabilities[:, 1]
        rows.append({
            "iteration": iteration,
            "validationLogLoss": float(log_loss(y_validation, p, labels=[0, 1])),
            "validationPrAuc": float(average_precision_score(y_validation, p)),
            "validationRocAuc": float(roc_auc_score(y_validation, p)),
        })
    return pd.DataFrame(rows)


def select_estimators(args, x_train, y_train, weights, x_validation, y_validation, grid):
    """Devuelve (n_estimators, reporte de selección, curva de validación)."""
    if args.estimator_selection == "fixed":
        return args.estimators, {
            "policy": "fixed",
            "estimators": int(args.estimators),
            "note": "Modo de reproducción; no constituye evidencia de convergencia.",
        }, None

    search = build_classifier(args, args.max_estimators, args.seed)
    search.fit(x_train, y_train, sample_weight=weights)
    curve = staged_validation_curve(search, x_validation, y_validation)
    rule = early_stopping_select(
        curve["validationLogLoss"].to_numpy(),
        patience=args.early_stopping_patience,
        min_delta=args.early_stopping_min_delta,
    )
    grid_rows = []
    for point in grid:
        if point > args.max_estimators:
            continue
        row = curve.loc[curve["iteration"].eq(point)].iloc[0]
        grid_rows.append({key: (int(value) if key == "iteration" else float(value)) for key, value in row.items()})

    stability = {"evaluated": False, "reason": "subsample == 1 (determinista)" if args.subsample >= 1 else "desactivado"}
    if args.subsample < 1 and args.stability_seeds > 0:
        seeds = seed_schedule(args.seed, args.stability_seeds)
        runs = []
        for seed in seeds:
            if seed == args.seed:
                seed_rule, seed_curve = rule, curve
            else:
                model = build_classifier(args, args.max_estimators, seed).fit(x_train, y_train, sample_weight=weights)
                seed_curve = staged_validation_curve(model, x_validation, y_validation)
                seed_rule = early_stopping_select(
                    seed_curve["validationLogLoss"].to_numpy(),
                    patience=args.early_stopping_patience,
                    min_delta=args.early_stopping_min_delta,
                )
            at_best = seed_curve.loc[seed_curve["iteration"].eq(seed_rule["bestIteration"])].iloc[0]
            runs.append({
                "seed": int(seed),
                "bestIteration": seed_rule["bestIteration"],
                "stoppedEarly": seed_rule["stoppedEarly"],
                "validationLogLossAtBest": float(at_best["validationLogLoss"]),
                "validationPrAucAtBest": float(at_best["validationPrAuc"]),
            })
        iterations = np.asarray([run["bestIteration"] for run in runs])
        stability = {
            "evaluated": True,
            "seeds": len(runs),
            "bestIterationMedian": float(np.median(iterations)),
            "bestIterationMin": int(iterations.min()),
            "bestIterationMax": int(iterations.max()),
            "allStoppedEarly": bool(all(run["stoppedEarly"] for run in runs)),
            "validationPrAucAtBestMean": float(np.mean([run["validationPrAucAtBest"] for run in runs])),
            "validationPrAucAtBestStd": float(np.std([run["validationPrAucAtBest"] for run in runs], ddof=1)) if len(runs) > 1 else 0.0,
            "runs": runs,
            "note": "El modelo exportado usa la semilla primaria; las demás semillas solo miden estabilidad.",
        }

    report = {
        "policy": "external_early_stopping",
        "selectionPartition": "validation",
        "testUsed": False,
        "rule": rule,
        "estimators": int(rule["bestIteration"]),
        "estimatorGrid": grid_rows,
        "seedStability": stability,
    }
    return int(rule["bestIteration"]), report, curve


def main():
    args = parse_args()
    if not 0 < args.max_validation_fpr <= 0.10:
        raise ValueError("MAX_VALIDATION_FPR_MUST_BE_GREATER_THAN_0_AND_AT_MOST_0_10")
    if not 0 < args.subsample <= 1:
        raise ValueError("SUBSAMPLE_MUST_BE_IN_(0,1]")
    if args.estimator_selection == "early-stopping" and args.max_estimators < args.early_stopping_patience + 1:
        raise ValueError("MAX_ESTIMATORS_TOO_SMALL_FOR_PATIENCE")
    grid = parse_int_grid(args.estimator_grid)

    dataset_path = Path(args.dataset).resolve()
    manifest_path = Path(args.manifest).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    frame = pd.read_csv(dataset_path, low_memory=False)
    feature_names = [name for name in frame.columns if name not in META_COLUMNS]
    if feature_names != manifest["featureNames"]:
        raise ValueError("FEATURE_ORDER_DIFFERS_FROM_MANIFEST")
    normalized = [name.lower().replace("_", "").replace("-", "") for name in feature_names]
    leaking = [name for name, value in zip(feature_names, normalized) if any(token in value for token in FORBIDDEN_FEATURE_TOKENS)]
    if leaking:
        raise ValueError(f"FORBIDDEN_FEATURES:{','.join(leaking)}")
    if frame[feature_names].isna().any().any():
        raise ValueError("FEATURES_CONTAIN_NULLS")
    if frame["cohortId"].duplicated().any():
        raise ValueError("DUPLICATE_COHORT_ID")
    group_splits = frame.groupby("matchedCaseId")["datasetSplit"].nunique()
    if (group_splits != 1).any():
        raise ValueError("MATCHED_GROUP_CROSSES_SPLITS")

    x = frame[feature_names].to_numpy(dtype=np.float64)
    invalid = ~np.isfinite(x)
    if invalid.any():
        columns = sorted({feature_names[index] for index in np.where(invalid)[1]})
        raise ValueError(f"FEATURES_CONTAIN_NON_FINITE_VALUES:{','.join(columns)}")
    too_large = np.abs(x) > np.finfo(np.float32).max
    if too_large.any():
        columns = sorted({feature_names[index] for index in np.where(too_large)[1]})
        raise ValueError(f"FEATURES_EXCEED_FLOAT32_RANGE:{','.join(columns)}")
    y = frame["target"].to_numpy(dtype=np.int8)
    masks = {name: frame["datasetSplit"].eq(name).to_numpy() for name in ("train", "validation", "test")}
    for name, mask in masks.items():
        if np.unique(y[mask]).tolist() != [0, 1]:
            raise ValueError(f"SPLIT_MISSING_CLASS:{name}")
    # El test solo se valida estructuralmente; sus métricas no se calculan aquí.
    open_splits = ("train", "validation")

    train_y = y[masks["train"]]
    positives = int(train_y.sum())
    controls = len(train_y) - positives
    weights = np.where(train_y == 1, len(train_y) / (2 * positives), len(train_y) / (2 * controls))
    validation_y = y[masks["validation"]]

    n_estimators, selection, curve = select_estimators(
        args, x[masks["train"]], train_y, weights, x[masks["validation"]], validation_y, grid,
    )
    classifier = build_classifier(args, n_estimators, args.seed)
    classifier.fit(x[masks["train"]], train_y, sample_weight=weights)
    if curve is not None:
        # El reentrenamiento con n_estimators=best debe coincidir con la etapa
        # seleccionada de la búsqueda (misma semilla y secuencia de submuestreo).
        expected = curve.loc[curve["iteration"].eq(n_estimators), "validationLogLoss"].iloc[0]
        observed = log_loss(validation_y, classifier.predict_proba(x[masks["validation"]])[:, 1], labels=[0, 1])
        if not math.isclose(expected, observed, rel_tol=0, abs_tol=1e-10):
            raise ValueError("EARLY_STOPPING_REFIT_MISMATCH")
        curve.to_csv(output_dir / "estimator-search-validation.csv", index=False)

    validation_raw = classifier.decision_function(x[masks["validation"]])
    calibrator = LogisticRegression(C=1.0, solver="lbfgs", max_iter=1000)
    calibrator.fit(validation_raw.reshape(-1, 1), validation_y)
    a = float(calibrator.coef_[0][0])
    b = float(calibrator.intercept_[0])
    probabilities = {
        name: sigmoid(a * classifier.decision_function(x[masks[name]]) + b)
        for name in open_splits
    }
    recall_threshold = choose_recall_threshold(validation_y, probabilities["validation"])
    controlled_threshold = choose_controlled_fpr_threshold(
        validation_y, probabilities["validation"], maximum_fpr=args.max_validation_fpr,
    )
    reports = {
        name: split_report(y[masks[name]], probabilities[name], recall_threshold, controlled_threshold)
        for name in open_splits
    }

    validation_groups = frame.loc[masks["validation"], "matchedCaseId"].astype(str).to_numpy()
    bootstrap = grouped_bootstrap(
        validation_y,
        validation_groups,
        {"candidate": probabilities["validation"]},
        thresholds={"candidate": controlled_threshold},
        repetitions=args.bootstrap,
        seed=args.seed + 1,
    )
    validation_ci = bootstrap["intervals"]["candidate"]
    reports["validation"]["bootstrap95"] = validation_ci
    lift = pr_auc_lift_assessment(
        reports["validation"]["prAuc"],
        validation_ci["prAuc"],
        reports["validation"]["nullPrAuc"],
        min_lift=args.min_pr_auc_lift,
    )
    reports["validation"]["prAucLiftOverPrevalence"] = lift

    checks = {
        "validationRocAucAtLeast0_70": reports["validation"]["rocAuc"] >= 0.70,
        "validationPrAucLower95ExceedsPrevalenceByMinLift": bool(lift["materialImprovementDemonstrated"]),
        "validationRecallAtControlledFprAtLeast0_50": reports["validation"]["controlledFprOperatingPoint"]["recall"] >= 0.50,
        "validationFalsePositiveRateAtMost0_10": reports["validation"]["controlledFprOperatingPoint"]["falsePositiveRate"] <= 0.10,
    }
    if args.estimator_selection == "early-stopping":
        checks["earlyStoppingConvergedBeforeSearchMaximum"] = bool(selection["rule"]["convergenceDemonstrated"])
    eligible = all(checks.values())

    stumps = export_stumps(classifier, feature_names)
    base_logit = float(classifier._raw_predict_init(x[masks["train"]][:1])[0][0])
    hyperparameters = {
        "nEstimators": int(n_estimators),
        "learningRate": float(args.learning_rate),
        "maxDepth": EXPORTABLE_MAX_DEPTH,
        "minSamplesLeaf": int(args.min_samples_leaf),
        "subsample": float(args.subsample),
        "seed": int(args.seed),
    }
    model = {
        "modelVersion": args.model_version,
        "status": "CHALLENGER",
        "algorithm": "gradient_boosted_stumps_v1",
        "featureSetVersion": manifest["featureSetVersion"],
        "studyDesign": "matched-case-control",
        "featureNames": feature_names,
        "baseLogit": base_logit,
        "learningRate": float(args.learning_rate),
        "stumps": stumps,
        "calibrator": {"type": "platt-case-control", "a": a, "b": b},
        "thresholds": {
            "recallFirst": recall_threshold,
            "candidateHighControlledFpr": controlled_threshold,
            "maximumValidationFpr": float(args.max_validation_fpr),
        },
        "hyperparameters": hyperparameters,
        "estimatorSelection": {key: value for key, value in selection.items() if key not in ("estimatorGrid", "seedStability")},
        "datasetHash": sha256_file(dataset_path),
        "createdAtMs": int(datetime.now(timezone.utc).timestamp() * 1000),
        "metrics": reports,
        "governance": {
            "promotionEligible": False,
            "freezeEligible": eligible,
            "decision": "READY_FOR_FREEZE" if eligible else "REJECTED",
            "checks": checks,
            "testPolicy": "SEALED_UNTIL_FREEZE",
            "testOpenedByTraining": False,
            "nextStep": "confirm-onchain-test.py (una sola apertura) y luego nueva cohorte externa" if eligible else None,
            "productionProbabilityReady": False,
        },
    }
    parity = []
    for index in np.linspace(0, len(frame) - 1, 12, dtype=int):
        feature = {name: float(frame.iloc[index][name]) for name in feature_names}
        exported = score_export(model, feature)
        native = float(sigmoid(a * classifier.decision_function(x[index:index + 1])[0] + b))
        if not math.isclose(exported, native, rel_tol=0, abs_tol=1e-12):
            raise ValueError("EXPORTED_MODEL_PARITY_FAILED")
        parity.append({"cohortId": frame.iloc[index]["cohortId"], "features": feature, "expectedProbability": exported})
    importances = sorted(zip(feature_names, classifier.feature_importances_), key=lambda item: item[1], reverse=True)
    report = {
        "ok": True,
        "modelVersion": args.model_version,
        "datasetHash": model["datasetHash"],
        "rows": int(len(frame)),
        "featureCount": len(feature_names),
        "hyperparameters": hyperparameters,
        "estimatorSelection": selection,
        "splits": reports,
        "sealedSplits": {"test": {"rows": int(masks["test"].sum()), "metricsComputed": False}},
        "promotion": model["governance"],
        "featureImportance": [{"feature": name, "importance": float(value)} for name, value in importances],
        "limitations": [
            "The matched case-control prevalence is sampled and does not represent production prevalence.",
            "The exported probability must not be interpreted as an absolute production risk until external prevalence calibration.",
            "Validation is reused for estimator selection, Platt calibration and threshold selection; validation metrics are optimistic and only support selection.",
            "The internal test split is sealed by this script and must be opened once with confirm-onchain-test.py after freezing.",
            "A new external temporal cohort is required; previously opened holdouts listed in governance/data-openings.json cannot be reused.",
        ],
    }
    (output_dir / "model-challenger-onchain.json").write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    (output_dir / "training-report-onchain.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output_dir / "model-parity-onchain.json").write_text(json.dumps(parity, indent=2) + "\n", encoding="utf-8")
    with open(output_dir / "feature-importance-onchain.csv", "w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target)
        writer.writerow(["feature", "importance"])
        writer.writerows(importances)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
