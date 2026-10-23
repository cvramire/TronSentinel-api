#!/usr/bin/env python3

import argparse
import csv
import json
from pathlib import Path

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap", type=int, default=2000)
    return parser.parse_args()


def load_latest(path):
    latest = {}
    with open(path, encoding="utf-8") as source:
        for line in source:
            if line.strip():
                row = json.loads(line)
                latest[row["externalId"]] = row
    return list(latest.values())


def confusion(y, prediction):
    y = np.asarray(y, dtype=int)
    prediction = np.asarray(prediction, dtype=bool)
    tp = int(np.sum((y == 1) & prediction))
    fn = int(np.sum((y == 1) & ~prediction))
    fp = int(np.sum((y == 0) & prediction))
    tn = int(np.sum((y == 0) & ~prediction))
    return {"tn": tn, "fp": fp, "fn": fn, "tp": tp}


def metrics(y, probabilities, prediction):
    matrix = confusion(y, prediction)
    precision = matrix["tp"] / (matrix["tp"] + matrix["fp"]) if matrix["tp"] + matrix["fp"] else 0
    recall = matrix["tp"] / (matrix["tp"] + matrix["fn"]) if matrix["tp"] + matrix["fn"] else 0
    fpr = matrix["fp"] / (matrix["fp"] + matrix["tn"]) if matrix["fp"] + matrix["tn"] else 0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "falsePositiveRate": fpr,
        "rocAuc": float(roc_auc_score(y, probabilities)),
        "prAuc": float(average_precision_score(y, probabilities)),
        "confusionMatrix": matrix,
    }


def interval(values):
    lower, median, upper = np.quantile(values, [0.025, 0.5, 0.975])
    return {"lower95": float(lower), "median": float(median), "upper95": float(upper)}


def bootstrap(y, probabilities, prediction, repetitions):
    rng = np.random.default_rng(20260927)
    y = np.asarray(y, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)
    prediction = np.asarray(prediction, dtype=bool)
    positive = np.where(y == 1)[0]
    control = np.where(y == 0)[0]
    samples = {name: [] for name in ["recall", "falsePositiveRate", "precision", "rocAuc", "prAuc"]}
    for _ in range(repetitions):
        indices = np.concatenate([
            rng.choice(positive, len(positive), replace=True),
            rng.choice(control, len(control), replace=True),
        ])
        current = metrics(y[indices], probabilities[indices], prediction[indices])
        for name in samples:
            samples[name].append(current[name])
    return {name: interval(values) for name, values in samples.items()}


def main():
    args = arguments()
    all_rows = load_latest(args.results)
    rows = [row for row in all_rows if row.get("ok")]
    if not rows:
        raise ValueError("NO_SCORED_ROWS")
    y = np.array([int(row["target"]) for row in rows])
    probabilities = np.array([float(row["response"]["sampleProbability"]) for row in rows])
    prediction = np.array([bool(row["response"]["reviewRecommended"]) for row in rows])
    if len(set(y)) < 2:
        raise ValueError("BOTH_CLASSES_REQUIRED")
    observed = metrics(y, probabilities, prediction)
    confidence = bootstrap(y, probabilities, prediction, args.bootstrap)
    positives = int(np.sum(y == 1))
    controls = int(np.sum(y == 0))
    checks = {
        "atLeast100ScoredPositives": positives >= 100,
        "atLeast300ScoredControls": controls >= 300,
        "recallLower95AtLeast0_50": confidence["recall"]["lower95"] >= 0.50,
        "fprUpper95AtMost0_10": confidence["falsePositiveRate"]["upper95"] <= 0.10,
        "rocAucLower95AtLeast0_70": confidence["rocAuc"]["lower95"] >= 0.70,
        "prAucLower95AtLeast0_50": confidence["prAuc"]["lower95"] >= 0.50,
    }
    eligible = all(checks.values())
    report = {
        "validationVersion": "tronsentinel-external-validation-v1",
        "rowsRequested": len(all_rows),
        "rowsScored": len(rows),
        "positivesScored": positives,
        "controlsScored": controls,
        "excluded": sum(1 for row in all_rows if row.get("excluded")),
        "errors": sum(1 for row in all_rows if not row.get("ok") and not row.get("excluded")),
        "metrics": observed,
        "bootstrap95": confidence,
        "governance": {
            "externalValidationEligible": eligible,
            "decision": "EXTERNAL_VALIDATION_PASSED" if eligible else "REMAIN_IN_SHADOW",
            "checks": checks,
            "thresholdChanged": False,
        },
    }
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / "external-validation-report.json", "w", encoding="utf-8") as target:
        json.dump(report, target, indent=2)
        target.write("\n")
    with open(output_dir / "external-validation-scored.csv", "w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=[
            "externalId", "matchedCaseId", "address", "target", "asOfUtc",
            "predictionId", "sampleProbability", "riskScore", "riskLevel",
            "reviewRecommended", "outcome",
        ])
        writer.writeheader()
        for row in rows:
            response = row["response"]
            predicted = bool(response["reviewRecommended"])
            outcome = ("TP" if predicted else "FN") if row["target"] == 1 else ("FP" if predicted else "TN")
            writer.writerow({
                "externalId": row["externalId"],
                "matchedCaseId": row["matchedCaseId"],
                "address": row["address"],
                "target": row["target"],
                "asOfUtc": row["asOfUtc"],
                "predictionId": response["predictionId"],
                "sampleProbability": response["sampleProbability"],
                "riskScore": response["riskScore"],
                "riskLevel": response["riskLevel"],
                "reviewRecommended": predicted,
                "outcome": outcome,
            })
    print(json.dumps({"ok": True, **report}, indent=2))


if __name__ == "__main__":
    main()
