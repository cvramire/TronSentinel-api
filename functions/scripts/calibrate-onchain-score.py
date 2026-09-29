#!/usr/bin/env python3

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


def parse_args():
    parser = argparse.ArgumentParser(description="Calibra score percentil del modelo on-chain")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--robustness", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--artifact-version", default="tronsentinel-wallet-shadow-v0.4.0-20260927")
    return parser.parse_args()


def sigmoid(value):
    value = np.clip(value, -40, 40)
    return 1.0 / (1.0 + np.exp(-value))


def score_export(model, frame):
    raw = np.full(len(frame), float(model["baseLogit"]), dtype=np.float64)
    for stump in model["stumps"]:
        values = frame[stump["feature"]].to_numpy(dtype=np.float64)
        branch = np.where(values <= float(stump["threshold"]), float(stump["leftValue"]), float(stump["rightValue"]))
        raw += float(model["learningRate"]) * branch
    calibrator = model["calibrator"]
    return sigmoid(float(calibrator["a"]) * raw + float(calibrator["b"]))


def main():
    args = parse_args()
    dataset = pd.read_csv(Path(args.dataset).resolve(), low_memory=False)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    model = json.loads(Path(args.model).read_text(encoding="utf-8"))
    robustness = json.loads(Path(args.robustness).read_text(encoding="utf-8"))
    if not robustness["governance"]["robustnessEligible"]:
        raise ValueError("MODEL_NOT_ROBUSTNESS_ELIGIBLE")
    if model["featureNames"] != manifest["featureNames"]:
        raise ValueError("MODEL_DATASET_FEATURE_MISMATCH")
    probabilities = score_export(model, dataset)
    development_controls = (
        dataset["target"].eq(0) & ~dataset["datasetSplit"].eq("test")
    ).to_numpy()
    reference = np.sort(probabilities[development_controls])
    if len(reference) < 100:
        raise ValueError("CONTROL_REFERENCE_TOO_SMALL")
    quantiles = {
        "p50": float(np.quantile(reference, 0.50)),
        "p80": float(np.quantile(reference, 0.80)),
        "p95": float(np.quantile(reference, 0.95)),
        "p99": float(np.quantile(reference, 0.99)),
    }
    artifact = {
        **model,
        "artifactVersion": args.artifact_version,
        "status": "CHALLENGER",
        "deploymentMode": "SHADOW",
        "labelVersion": "tronsentinel-blacklist-labels-2026-09-27-v6.4",
        "lookbackDays": int(manifest["lookbackDays"]),
        "productionProbabilityReady": False,
        "scoreCalibration": {
            "type": "empirical_control_percentile_v1",
            "referencePopulation": "train_and_validation_controls",
            "referenceSampleCount": int(len(reference)),
            "referenceScores": [float(value) for value in reference],
            "probabilityQuantiles": quantiles,
            "riskBands": {"lowMax": 49, "mediumMax": 79, "highMax": 94},
            "interpretation": "Percentile de similitud de riesgo frente a controles de desarrollo; no es probabilidad absoluta.",
        },
        "shadowThreshold": {
            "reviewProbability": float(model["thresholds"]["candidateHighControlledFpr"]),
            "selection": "validation_fpr_at_most_0.10",
        },
        "metrics": {
            "cleanTest": robustness["cleanModelTest"],
            "bootstrap95": robustness["bootstrap95"],
            "ablationDrops": robustness["ablationDrops"],
        },
        "governance": {
            **robustness["governance"],
            "productionPromotionAllowed": False,
            "shadowDeploymentAllowed": True,
        },
        "calibratedAtUtc": datetime.now(timezone.utc).isoformat(),
    }
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "wallet-shadow-model.json"
    output_path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
    summary = {
        "ok": True,
        "artifactVersion": artifact["artifactVersion"],
        "modelVersion": artifact["modelVersion"],
        "deploymentMode": artifact["deploymentMode"],
        "referenceSampleCount": len(reference),
        "probabilityQuantiles": quantiles,
        "reviewProbability": artifact["shadowThreshold"]["reviewProbability"],
        "productionProbabilityReady": False,
        "shadowDeploymentAllowed": True,
        "output": str(output_path),
    }
    (output_dir / "wallet-shadow-calibration-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
