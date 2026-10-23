#!/usr/bin/env python3
"""Congela un candidato READY_FOR_FREEZE antes de abrir el test interno.

Registra hashes del modelo, reportes y dataset. confirm-onchain-test.py
verifica que el modelo coincida con este manifiesto.
"""

import argparse
import json
from pathlib import Path

from onchain_governance import sha256_file, utc_now


def parse_args():
    parser = argparse.ArgumentParser(description="Congela un candidato on-chain")
    parser.add_argument("--model-dir", required=True, help="Carpeta de salida de train-onchain-model.py")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    return parser.parse_args()


def main():
    args = parse_args()
    model_dir = Path(args.model_dir).resolve()
    model_path = model_dir / "model-challenger-onchain.json"
    report_path = model_dir / "training-report-onchain.json"
    freeze_path = model_dir / "candidate-freeze-manifest.json"
    if freeze_path.exists():
        raise SystemExit("CANDIDATE_ALREADY_FROZEN")
    model = json.loads(model_path.read_text(encoding="utf-8"))
    governance = model.get("governance", {})
    if governance.get("decision") != "READY_FOR_FREEZE":
        raise SystemExit(f"MODEL_NOT_READY_FOR_FREEZE:{governance.get('decision')}")
    dataset_hash = sha256_file(args.dataset)
    if dataset_hash != model["datasetHash"]:
        raise SystemExit("DATASET_DIFFERS_FROM_TRAINING_DATASET")
    manifest = {
        "freezeStatus": "FROZEN_FOR_ONE_TIME_INTERNAL_TEST",
        "modelVersion": model["modelVersion"],
        "algorithm": model["algorithm"],
        "singleClassifier": True,
        "featureSetVersion": model["featureSetVersion"],
        "featureCount": len(model["featureNames"]),
        "hyperparameters": model.get("hyperparameters"),
        "estimatorSelection": model.get("estimatorSelection"),
        "datasetHash": dataset_hash,
        "threshold": model["thresholds"]["candidateHighControlledFpr"],
        "maximumValidationFpr": model["thresholds"]["maximumValidationFpr"],
        "productionProbabilityReady": False,
        "trainingGovernance": governance,
        "holdoutPolicy": {
            "internalTestOpenings": 1,
            "externalHoldoutOpenings": 1,
            "thresholdChangesAfterOpening": False,
            "retrainingAfterOpening": False,
        },
        "fileHashes": {
            "model": sha256_file(model_path),
            "trainingReport": sha256_file(report_path),
            "developmentDataset": dataset_hash,
            "developmentManifest": sha256_file(args.manifest),
        },
        "frozenAtUtc": utc_now(),
    }
    freeze_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "freezeManifest": str(freeze_path), "modelHash": manifest["fileHashes"]["model"]}, indent=2))


if __name__ == "__main__":
    main()
