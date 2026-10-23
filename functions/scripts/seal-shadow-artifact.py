#!/usr/bin/env python3
"""Sella un artefacto SHADOW tras aprobar el test interno y el holdout externo.

Es el único paso que habilita governance.shadowDeploymentAllowed, requisito de
import-shadow-artifacts.mjs. Verifica que el artefacto calibrado proviene del
mismo modelo congelado y confirmado (stumps, calibrador y umbral idénticos).
"""

import argparse
import json
from pathlib import Path

from onchain_governance import load_ledger, sha256_file, utc_now


DEFAULT_LEDGER = Path(__file__).resolve().parents[2] / "governance" / "data-openings.json"


def parse_args():
    parser = argparse.ArgumentParser(description="Sella el artefacto SHADOW aprobado")
    parser.add_argument("--shadow-model", required=True, help="wallet-shadow-model.json de calibrate-onchain-score.py")
    parser.add_argument("--challenger", required=True, help="model-challenger-onchain.json congelado")
    parser.add_argument("--internal-confirmation", required=True, help="internal-test-confirmation.json")
    parser.add_argument("--external-confirmation", required=True, help="external-holdout-confirmation.json")
    parser.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    return parser.parse_args()


def main():
    args = parse_args()
    shadow_path = Path(args.shadow_model).resolve()
    shadow = json.loads(shadow_path.read_text(encoding="utf-8"))
    challenger_path = Path(args.challenger).resolve()
    challenger = json.loads(challenger_path.read_text(encoding="utf-8"))
    challenger_hash = sha256_file(challenger_path)
    internal_path = Path(args.internal_confirmation).resolve()
    external_path = Path(args.external_confirmation).resolve()
    internal = json.loads(internal_path.read_text(encoding="utf-8"))
    external = json.loads(external_path.read_text(encoding="utf-8"))

    for key in ("modelVersion", "featureNames", "baseLogit", "learningRate", "stumps", "calibrator", "thresholds"):
        if shadow.get(key) != challenger.get(key):
            raise SystemExit(f"SHADOW_ARTIFACT_DIFFERS_FROM_FROZEN_MODEL:{key}")
    if internal.get("modelHash") != challenger_hash or external.get("modelHash") != challenger_hash:
        raise SystemExit("CONFIRMATION_MODEL_HASH_MISMATCH")
    if internal.get("decision") != "PASSED_INTERNAL_TEST_REQUIRES_NEW_EXTERNAL_COHORT":
        raise SystemExit(f"INTERNAL_TEST_NOT_PASSED:{internal.get('decision')}")
    if external.get("decision") != "PASSED_EXTERNAL_HOLDOUT_ELIGIBLE_FOR_SHADOW_REVIEW":
        raise SystemExit(f"EXTERNAL_HOLDOUT_NOT_PASSED:{external.get('decision')}")
    ledger = load_ledger(args.ledger)
    for report in (internal, external):
        recorded = [
            item for item in ledger["openings"]
            if item.get("partition") == report["partition"]
            and item.get("datasetHash") == report["datasetHash"]
            and item.get("modelHash") == challenger_hash
        ]
        if not recorded:
            raise SystemExit(f"OPENING_NOT_IN_LEDGER:{report['partition']}")
    if not shadow.get("governance", {}).get("robustnessEligible"):
        raise SystemExit("MODEL_NOT_ROBUSTNESS_ELIGIBLE")

    sealed = {
        **shadow,
        "governance": {
            **shadow["governance"],
            "productionPromotionAllowed": False,
            "shadowDeploymentAllowed": True,
            "internalTestPassed": True,
            "internalTestReportSha256": sha256_file(internal_path),
            "externalHoldoutPassed": True,
            "externalHoldoutDecision": external["decision"],
            "externalHoldoutReportSha256": sha256_file(external_path),
            "singleClassifierForDeployment": True,
            "holdoutUsedForTuning": False,
        },
        "externalValidation": {
            "evaluationType": external["evaluationType"],
            "decision": external["decision"],
            "openedAtUtc": external["openedAtUtc"],
            "datasetHash": external["datasetHash"],
            "rows": external["rows"],
            "positives": external["positives"],
            "controls": external["controls"],
            "threshold": external["threshold"],
            "metrics": external["metrics"],
            "bootstrap95": external["bootstrap95"],
            "checks": external["checks"],
            "holdoutUsedForTuning": False,
            "modelRetrainedAfterOpening": False,
            "thresholdChangedAfterOpening": False,
        },
        "sealedForShadowAtUtc": utc_now(),
    }
    output = shadow_path.parent / "wallet-shadow-model-external-approved.json"
    output.write_text(json.dumps(sealed, indent=2) + "\n", encoding="utf-8")
    release = {
        "releaseStatus": "APPROVED_FOR_SHADOW_DEPLOYMENT",
        "artifactVersion": sealed["artifactVersion"],
        "modelVersion": sealed["modelVersion"],
        "deploymentMode": "SHADOW",
        "singleClassifier": True,
        "threshold": sealed["thresholds"]["candidateHighControlledFpr"],
        "productionProbabilityReady": False,
        "automaticActionsAllowed": False,
        "hashes": {
            "frozenChallenger": challenger_hash,
            "sourceShadowArtifact": sha256_file(shadow_path),
            "sealedShadowArtifact": sha256_file(output),
            "internalTestReport": sha256_file(internal_path),
            "externalHoldoutReport": sha256_file(external_path),
        },
        "createdAtUtc": utc_now(),
    }
    (shadow_path.parent / "wallet-shadow-release-manifest.json").write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "sealed": str(output), **release["hashes"]}, indent=2))


if __name__ == "__main__":
    main()
