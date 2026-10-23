#!/usr/bin/env python3
"""Apertura única de una partición sellada para un candidato congelado.

Flujo obligatorio:
  entrenamiento -> comparación en validación -> configuración congelada ->
  test interno (una apertura) -> nueva cohorte externa -> aprobación SHADOW

Este script:
- exige un modelo con decisión READY_FOR_FREEZE (salvo --partition external-holdout,
  que exige además una confirmación interna previa del mismo modelo);
- rechaza particiones ya abiertas según governance/data-openings.json;
- registra la apertura antes de calcular métricas, de modo que un resultado
  desfavorable no pueda descartarse para volver a escoger otra estrategia;
- no modifica el modelo, el umbral ni la calibración.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from onchain_governance import (
    DEFAULT_BOOTSTRAP_REPETITIONS,
    DEFAULT_MIN_PR_AUC_LIFT,
    assert_partition_unopened,
    grouped_bootstrap,
    load_ledger,
    null_pr_auc,
    pr_auc_lift_assessment,
    record_opening,
    sha256_file,
    utc_now,
)


DEFAULT_LEDGER = Path(__file__).resolve().parents[2] / "governance" / "data-openings.json"


def parse_args():
    parser = argparse.ArgumentParser(description="Confirma un candidato congelado sobre una partición sellada")
    parser.add_argument("--model", required=True, help="model-challenger-onchain.json congelado")
    parser.add_argument("--dataset", required=True, help="CSV con features, target y matchedCaseId")
    parser.add_argument("--partition", choices=("internal-test", "external-holdout"), required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    parser.add_argument("--purpose", required=True, help="Motivo registrado en el ledger")
    parser.add_argument("--bootstrap", type=int, default=DEFAULT_BOOTSTRAP_REPETITIONS)
    parser.add_argument("--min-pr-auc-lift", type=float, default=DEFAULT_MIN_PR_AUC_LIFT)
    parser.add_argument("--seed", type=int, default=20260927)
    return parser.parse_args()


def sigmoid(value):
    return 1.0 / (1.0 + np.exp(-np.clip(value, -40, 40)))


def score_export(model, frame):
    raw = np.full(len(frame), float(model["baseLogit"]), dtype=np.float64)
    rate = float(model["learningRate"])
    for stump in model["stumps"]:
        values = frame[stump["feature"]].to_numpy(dtype=np.float64)
        raw += rate * np.where(values <= float(stump["threshold"]), float(stump["leftValue"]), float(stump["rightValue"]))
    calibrator = model["calibrator"]
    return sigmoid(float(calibrator["a"]) * raw + float(calibrator["b"]))


def main():
    args = parse_args()
    model_path = Path(args.model).resolve()
    dataset_path = Path(args.dataset).resolve()
    output_dir = Path(args.output_dir).resolve()
    model = json.loads(model_path.read_text(encoding="utf-8"))
    model_hash = sha256_file(model_path)
    dataset_hash = sha256_file(dataset_path)

    governance = model.get("governance", {})
    if governance.get("decision") != "READY_FOR_FREEZE":
        raise SystemExit(f"MODEL_NOT_READY_FOR_FREEZE:{governance.get('decision')}")
    freeze_path = model_path.parent / "candidate-freeze-manifest.json"
    if not freeze_path.exists():
        raise SystemExit("CANDIDATE_NOT_FROZEN: ejecutar freeze-candidate.py primero")
    freeze = json.loads(freeze_path.read_text(encoding="utf-8"))
    if freeze.get("fileHashes", {}).get("model") != model_hash:
        raise SystemExit("MODEL_CHANGED_AFTER_FREEZE")

    ledger = load_ledger(args.ledger)
    assert_partition_unopened(ledger, dataset_hash, args.partition)
    if args.partition == "external-holdout":
        internal = [item for item in ledger["openings"] if item.get("partition") == "internal-test" and item.get("modelHash") == model_hash]
        if not internal:
            raise SystemExit("EXTERNAL_HOLDOUT_REQUIRES_PRIOR_INTERNAL_TEST_CONFIRMATION_OF_SAME_MODEL")
    else:
        # La partición interna se identifica por el dataset de desarrollo del modelo.
        if dataset_hash != model.get("datasetHash"):
            raise SystemExit("INTERNAL_TEST_DATASET_DIFFERS_FROM_TRAINING_DATASET")

    frame = pd.read_csv(dataset_path, low_memory=False)
    if args.partition == "internal-test":
        frame = frame.loc[frame["datasetSplit"].eq("test")].reset_index(drop=True)
    missing = [name for name in model["featureNames"] if name not in frame.columns]
    if missing:
        raise SystemExit(f"DATASET_MISSING_FEATURES:{','.join(missing)}")
    y = frame["target"].to_numpy(dtype=np.int8)
    if sorted(np.unique(y).tolist()) != [0, 1]:
        raise SystemExit("PARTITION_MISSING_CLASS")

    # Registrar primero: desde este punto la partición queda consumida.
    record = record_opening(args.ledger, {
        "partition": args.partition,
        "datasetHash": dataset_hash,
        "openedFor": model["modelVersion"],
        "modelHash": model_hash,
        "purpose": args.purpose,
        "openedBy": "confirm-onchain-test.py",
    })

    probabilities = score_export(model, frame)
    threshold = float(model["thresholds"]["candidateHighControlledFpr"])
    groups = frame["matchedCaseId"].astype(str).to_numpy()
    bootstrap = grouped_bootstrap(
        y, groups, {"candidate": probabilities}, thresholds={"candidate": threshold},
        repetitions=args.bootstrap, seed=args.seed + 3,
    )
    intervals = bootstrap["intervals"]["candidate"]
    prevalence = null_pr_auc(y)
    lift = pr_auc_lift_assessment(intervals["prAuc"]["point"], intervals["prAuc"], prevalence, args.min_pr_auc_lift)
    constant_brier = float(brier_score_loss(y, np.full(len(y), prevalence)))
    brier = float(brier_score_loss(y, probabilities))
    checks = {
        "prAucLower95ExceedsPrevalenceByMinLift": bool(lift["materialImprovementDemonstrated"]),
        "rocAucLower95AtLeast0_70": intervals["rocAuc"]["lower95"] >= 0.70,
        "recallLower95AtLeast0_50": intervals["recall"]["lower95"] >= 0.50,
        "falsePositiveRateUpper95AtMost0_10": intervals["falsePositiveRate"]["upper95"] <= 0.10,
        "brierBetterThanConstantBaseline": brier < constant_brier,
    }
    passed = all(checks.values())
    next_decision = {
        ("internal-test", True): "PASSED_INTERNAL_TEST_REQUIRES_NEW_EXTERNAL_COHORT",
        ("internal-test", False): "FAILED_INTERNAL_TEST_START_NEW_CYCLE_WITH_FUTURE_DATA",
        ("external-holdout", True): "PASSED_EXTERNAL_HOLDOUT_ELIGIBLE_FOR_SHADOW_REVIEW",
        ("external-holdout", False): "FAILED_EXTERNAL_HOLDOUT_START_NEW_CYCLE_WITH_FUTURE_DATA",
    }[(args.partition, passed)]
    report = {
        "ok": True,
        "evaluationType": "ONE_TIME_SEALED_PARTITION",
        "partition": args.partition,
        "openedAtUtc": record["openedAtUtc"],
        "modelVersion": model["modelVersion"],
        "modelHash": model_hash,
        "datasetHash": dataset_hash,
        "threshold": threshold,
        "rows": int(len(y)),
        "positives": int(y.sum()),
        "controls": int(len(y) - y.sum()),
        "groups": int(len(np.unique(groups))),
        "metrics": {
            "prAuc": float(average_precision_score(y, probabilities)),
            "rocAuc": float(roc_auc_score(y, probabilities)),
            "brier": brier,
            "constantBaselineBrier": constant_brier,
        },
        "bootstrap95": intervals,
        "bootstrapMethod": {key: bootstrap[key] for key in ("method", "repetitions", "groups", "seed")},
        "prAucLiftOverPrevalence": lift,
        "checks": checks,
        "decision": next_decision,
        "rules": [
            "Tras esta apertura no se permite volver a escoger otra estrategia, umbral o calibración usando esta partición.",
            "Una debilidad detectada se registra y se aborda en un nuevo ciclo con datos futuros.",
            "Las probabilidades siguen siendo de muestra caso-control; el score es un percentil relativo.",
        ],
        "generatedAtUtc": utc_now(),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    name = "internal-test-confirmation.json" if args.partition == "internal-test" else "external-holdout-confirmation.json"
    (output_dir / name).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
