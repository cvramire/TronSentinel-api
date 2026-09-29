#!/usr/bin/env python3

import argparse
import csv
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)


MONETARY_FEATURES = {
    "totalAmount", "inboundAmount", "outboundAmount", "netFlowAmount",
    "meanAmount", "amountStd", "amountCv", "maxAmount", "usdtAmount", "tusdAmount",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Evalúa robustez del challenger on-chain")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stress-dataset")
    parser.add_argument("--bootstrap", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=20260927)
    return parser.parse_args()


def sigmoid(value):
    value = np.clip(value, -40, 40)
    return 1.0 / (1.0 + np.exp(-value))


def score_export(model, frame):
    raw = np.full(len(frame), float(model["baseLogit"]), dtype=np.float64)
    rate = float(model["learningRate"])
    for stump in model["stumps"]:
        values = frame[stump["feature"]].to_numpy(dtype=np.float64)
        branch = np.where(values <= float(stump["threshold"]), float(stump["leftValue"]), float(stump["rightValue"]))
        raw += rate * branch
    calibrator = model["calibrator"]
    return sigmoid(float(calibrator["a"]) * raw + float(calibrator["b"]))


def threshold_metrics(y_true, probabilities, threshold):
    predicted = (probabilities >= threshold).astype(np.int8)
    tn, fp, fn, tp = confusion_matrix(y_true, predicted, labels=[0, 1]).ravel()
    precision = precision_score(y_true, predicted, zero_division=0)
    recall = recall_score(y_true, predicted, zero_division=0)
    return {
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(2 * precision * recall / max(precision + recall, 1e-15)),
        "falsePositiveRate": float(fp / max(fp + tn, 1)),
        "confusionMatrix": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def full_metrics(y_true, probabilities, threshold):
    result = threshold_metrics(y_true, probabilities, threshold)
    result["rocAuc"] = float(roc_auc_score(y_true, probabilities))
    result["prAuc"] = float(average_precision_score(y_true, probabilities))
    return result


def choose_controlled_threshold(y_true, probabilities, maximum_fpr=0.10):
    eligible = []
    for threshold in np.unique(probabilities):
        metrics = threshold_metrics(y_true, probabilities, float(threshold))
        if metrics["falsePositiveRate"] <= maximum_fpr:
            eligible.append((metrics["recall"], metrics["precision"], -float(threshold), float(threshold)))
    return max(eligible)[-1] if eligible else 1.0


def percentile_interval(values):
    low, median, high = np.percentile(values, [2.5, 50, 97.5])
    return {"lower95": float(low), "median": float(median), "upper95": float(high)}


def bootstrap_groups(frame, probabilities, threshold, repetitions, seed):
    rng = np.random.default_rng(seed)
    groups = frame["matchedCaseId"].unique()
    indexes = {group: np.flatnonzero(frame["matchedCaseId"].to_numpy() == group) for group in groups}
    y = frame["target"].to_numpy(dtype=np.int8)
    results = {name: [] for name in ("rocAuc", "prAuc", "precision", "recall", "f1", "falsePositiveRate")}
    completed = 0
    while completed < repetitions:
        sampled = rng.choice(groups, size=len(groups), replace=True)
        selection = np.concatenate([indexes[group] for group in sampled])
        sample_y = y[selection]
        if len(np.unique(sample_y)) < 2:
            continue
        metrics = full_metrics(sample_y, probabilities[selection], threshold)
        for name in results:
            results[name].append(metrics[name])
        completed += 1
    return {name: percentile_interval(values) for name, values in results.items()}


def train_ablation(frame, feature_names, seed):
    selected = [name for name in feature_names if name not in MONETARY_FEATURES]
    x = frame[selected].to_numpy(dtype=np.float64)
    y = frame["target"].to_numpy(dtype=np.int8)
    masks = {name: frame["datasetSplit"].eq(name).to_numpy() for name in ("train", "validation", "test")}
    train_y = y[masks["train"]]
    positives = int(train_y.sum())
    controls = len(train_y) - positives
    weights = np.where(train_y == 1, len(train_y) / (2 * positives), len(train_y) / (2 * controls))
    classifier = GradientBoostingClassifier(
        n_estimators=150, learning_rate=0.04, max_depth=1,
        min_samples_leaf=20, subsample=0.8, random_state=seed,
    )
    classifier.fit(x[masks["train"]], train_y, sample_weight=weights)
    validation_raw = classifier.decision_function(x[masks["validation"]])
    calibrator = LogisticRegression(C=1.0, solver="lbfgs", max_iter=1000)
    calibrator.fit(validation_raw.reshape(-1, 1), y[masks["validation"]])
    a = float(calibrator.coef_[0][0])
    b = float(calibrator.intercept_[0])
    probabilities = {
        name: sigmoid(a * classifier.decision_function(x[mask]) + b)
        for name, mask in masks.items()
    }
    threshold = choose_controlled_threshold(y[masks["validation"]], probabilities["validation"])
    importances = sorted(zip(selected, classifier.feature_importances_), key=lambda item: item[1], reverse=True)
    return {
        "excludedFeatures": sorted(MONETARY_FEATURES),
        "featureCount": len(selected),
        "threshold": threshold,
        "validation": full_metrics(y[masks["validation"]], probabilities["validation"], threshold),
        "test": full_metrics(y[masks["test"]], probabilities["test"], threshold),
        "featureImportance": [{"feature": name, "importance": float(value)} for name, value in importances[:15]],
    }


def control_percentile(probability, control_reference):
    return float(100 * np.searchsorted(control_reference, probability, side="right") / len(control_reference))


def main():
    args = parse_args()
    dataset = pd.read_csv(Path(args.dataset).resolve(), low_memory=False)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    feature_names = manifest["featureNames"]
    if model["featureNames"] != feature_names:
        raise ValueError("MODEL_DATASET_FEATURE_MISMATCH")
    probabilities = score_export(model, dataset)
    threshold = float(model["thresholds"]["candidateHighControlledFpr"])
    test_mask = dataset["datasetSplit"].eq("test").to_numpy()
    validation_controls = np.sort(probabilities[(dataset["datasetSplit"].eq("validation") & dataset["target"].eq(0)).to_numpy()])
    test = dataset.loc[test_mask].reset_index(drop=True)
    test_probabilities = probabilities[test_mask]
    clean_test = full_metrics(test["target"].to_numpy(dtype=np.int8), test_probabilities, threshold)
    bootstrap = bootstrap_groups(test, test_probabilities, threshold, args.bootstrap, args.seed)
    ablation = train_ablation(dataset, feature_names, args.seed)

    stress = {
        "available": False,
        "scoringPolicy": "COMPLETE_HISTORY_ONLY",
    }
    if args.stress_dataset:
        stress_frame = pd.read_csv(
            Path(args.stress_dataset).resolve(),
            low_memory=False,
        )
        rows = []
        for _, row in stress_frame.iterrows():
            rows.append({
                "cohortId": row["cohortId"],
                "address": row["address"],
                "target": int(row["target"]),
                "status": "NOT_SCORABLE",
                "reason": "HISTORY_TRUNCATED",
            })
        stress = {
            "available": True,
            "rows": len(rows),
            "scored": 0,
            "notScorable": len(rows),
            "flaggedHigh": None,
            "flagRate": None,
            "scoringPolicy": "COMPLETE_HISTORY_ONLY",
            "interpretation": (
                "Historiales censurados no reciben score. "
                "La API debe responder HISTORY_TRUNCATED."
            ),
            "scores": rows,
        }
        with open(
            output_dir /
            "censored-control-stress-scores.csv",
            "w",
            newline="",
            encoding="utf-8",
        ) as target:
            fields = (
                list(rows[0].keys())
                if rows
                else ["cohortId"]
            )
            writer = csv.DictWriter(
                target,
                fieldnames=fields,
            )
            writer.writeheader()
            writer.writerows(rows)

    drops = {
        "rocAuc": clean_test["rocAuc"] - ablation["test"]["rocAuc"],
        "prAuc": clean_test["prAuc"] - ablation["test"]["prAuc"],
        "recall": clean_test["recall"] - ablation["test"]["recall"],
    }
    checks = {
        "bootstrapRecallLower95AtLeast0_50": bootstrap["recall"]["lower95"] >= 0.50,
        "bootstrapFprUpper95AtMost0_10": bootstrap["falsePositiveRate"]["upper95"] <= 0.10,
        "bootstrapRocAucLower95AtLeast0_70": bootstrap["rocAuc"]["lower95"] >= 0.70,
        "bootstrapPrAucLower95AtLeast0_50": bootstrap["prAuc"]["lower95"] >= 0.50,
        "ablationTestRocAucAtLeast0_70": ablation["test"]["rocAuc"] >= 0.70,
        "ablationTestPrAucAtLeast0_50": ablation["test"]["prAuc"] >= 0.50,
        "ablationRocAucDropAtMost0_15": drops["rocAuc"] <= 0.15,
        "ablationPrAucDropAtMost0_20": drops["prAuc"] <= 0.20,
    }
    report = {
        "ok": True,
        "modelVersion": model["modelVersion"],
        "threshold": threshold,
        "bootstrapRepetitions": args.bootstrap,
        "cleanModelTest": clean_test,
        "bootstrap95": bootstrap,
        "monetaryFeatureAblation": ablation,
        "ablationDrops": drops,
        "censoredControlStress": stress,
        "governance": {
            "robustnessEligible": all(checks.values()),
            "decision": "APPROVED_FOR_SCORE_CALIBRATION" if all(checks.values()) else "REVIEW_REQUIRED",
            "checks": checks,
            "stressTestIsExploratory": True,
        },
    }
    (output_dir / "robustness-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
