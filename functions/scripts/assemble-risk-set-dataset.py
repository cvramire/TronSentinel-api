#!/usr/bin/env python3
"""Ensambla el dataset de desarrollo o el holdout externo de un risk set.

Une positivos (salida de split-positive-cases.py) con controles completos
(salida de build-onchain-features.mjs sobre los controles del risk set):

- development: partición cronológica agrupada 70/15/15 por matchedCaseId,
  ordenada por la fecha índice del caso.
- external: todas las filas con datasetSplit = external_holdout.

Solo conserva casos con al menos un control completo y verifica: orden de
variables, ausencia de nulos y no finitos, fechas índice consistentes, y que
ninguna dirección aparezca en los archivos de --exclude.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

from onchain_governance import sha256_file, utc_now


META_COLUMNS = ["cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target"]
FORBIDDEN_FEATURE_TOKENS = ("blacklist", "blocklist", "label", "riskscore", "risklevel")


def parse_args():
    parser = argparse.ArgumentParser(description="Ensambla un dataset risk-set de TronSentinel")
    parser.add_argument("--mode", choices=("development", "external"), required=True)
    parser.add_argument("--cases", required=True, help="cases-development.csv o cases-external.csv")
    parser.add_argument("--controls-features", required=True, action="append",
                        help="onchain-feature-dataset.csv de controles (repetible)")
    parser.add_argument("--controls-manifest", required=True, help="Manifiesto de features de los controles")
    parser.add_argument("--exclude", action="append", default=[],
                        help="CSV con columna address cuyas direcciones no pueden aparecer (repetible)")
    parser.add_argument("--dataset-version", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--min-controls-per-case", type=int, default=1)
    parser.add_argument("--train-fraction", type=float, default=0.70)
    parser.add_argument("--validation-fraction", type=float, default=0.15)
    return parser.parse_args()


def chronological_group_split(cases: pd.DataFrame, train_fraction: float, validation_fraction: float):
    ordered = cases.assign(_index=pd.to_datetime(cases["indexAtUtc"], utc=True)).sort_values(["_index", "matchedCaseId"])
    groups = ordered["matchedCaseId"].tolist()
    count = len(groups)
    train_end = int(round(count * train_fraction))
    validation_end = int(round(count * (train_fraction + validation_fraction)))
    if not 0 < train_end < validation_end < count:
        raise SystemExit("NOT_ENOUGH_GROUPS_FOR_SPLIT")
    return {
        group: "train" if position < train_end else "validation" if position < validation_end else "test"
        for position, group in enumerate(groups)
    }


def main():
    args = parse_args()
    manifest = json.loads(Path(args.controls_manifest).read_text(encoding="utf-8"))
    feature_names = manifest["featureNames"]
    normalized = [name.lower().replace("_", "").replace("-", "") for name in feature_names]
    leaking = [name for name, value in zip(feature_names, normalized) if any(token in value for token in FORBIDDEN_FEATURE_TOKENS)]
    if leaking:
        raise SystemExit(f"FORBIDDEN_FEATURES:{','.join(leaking)}")

    cases_path = Path(args.cases).resolve()
    cases = pd.read_csv(cases_path, dtype=str, keep_default_na=False)
    cases = cases.loc[cases["target"].astype(int).eq(1)].copy()
    cases["matchedCaseId"] = cases["matchedCaseId"].where(cases["matchedCaseId"].ne(""), cases["cohortId"])
    controls_paths = [Path(item).resolve() for item in args.controls_features]
    controls = pd.concat([pd.read_csv(path, dtype=str, keep_default_na=False) for path in controls_paths], ignore_index=True)
    controls = controls.loc[controls["target"].astype(int).eq(0)].copy()
    for name, part in (("cases", cases), ("controls", controls)):
        missing = [column for column in META_COLUMNS[:4] + ["target"] + feature_names if column not in part.columns]
        if missing:
            raise SystemExit(f"{name.upper()}_MISSING_COLUMNS:{','.join(missing[:10])}")

    controls = controls.loc[controls["matchedCaseId"].isin(set(cases["matchedCaseId"]))]
    controls = controls.drop_duplicates("address", keep="first")
    counts = controls.groupby("matchedCaseId").size()
    eligible = set(counts[counts >= args.min_controls_per_case].index)
    excluded_cases = sorted(set(cases["matchedCaseId"]) - eligible)
    cases = cases.loc[cases["matchedCaseId"].isin(eligible)]
    controls = controls.loc[controls["matchedCaseId"].isin(eligible)]

    case_index = cases.set_index("matchedCaseId")["indexAtUtc"]
    temporal_mismatches = int((controls["indexAtUtc"].to_numpy() != case_index.loc[controls["matchedCaseId"]].to_numpy()).sum())
    overlap = len(set(cases["address"]) & set(controls["address"]))
    if overlap:
        raise SystemExit(f"CASE_CONTROL_ADDRESS_OVERLAP:{overlap}")

    excluded_addresses = set()
    exclude_hashes = []
    for item in args.exclude:
        path = Path(item).resolve()
        excluded_addresses |= set(pd.read_csv(path, usecols=["address"], dtype=str)["address"])
        exclude_hashes.append({"file": str(path), "sha256": sha256_file(path)})
    combined = pd.concat([cases, controls], ignore_index=True)
    external_overlap = int(combined["address"].isin(excluded_addresses).sum())
    if external_overlap:
        raise SystemExit(f"ADDRESSES_FOUND_IN_EXCLUDED_FILES:{external_overlap}")

    if args.mode == "development":
        split = chronological_group_split(cases, args.train_fraction, args.validation_fraction)
        combined["datasetSplit"] = combined["matchedCaseId"].map(split)
    else:
        combined["datasetSplit"] = "external_holdout"
    combined["target"] = combined["target"].astype(int).astype(str)
    combined["_order"] = pd.to_datetime(combined["indexAtUtc"], utc=True)
    combined = combined.sort_values(["_order", "matchedCaseId", "target", "cohortId"], ascending=[True, True, False, True])
    combined = combined[META_COLUMNS + feature_names].reset_index(drop=True)

    # Los valores se copian como texto (sin reformatear decimales); se validan aparte.
    values = combined[feature_names].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float64)
    non_finite = int((~np.isfinite(values)).sum())
    if non_finite:
        raise SystemExit(f"FEATURES_CONTAIN_NULL_OR_NON_FINITE:{non_finite}")
    if combined["cohortId"].duplicated().any():
        raise SystemExit("DUPLICATE_COHORT_ID")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = "onchain-feature-dataset.csv" if args.mode == "development" else "external-holdout-dataset.csv"
    dataset_path = output_dir / filename
    combined.to_csv(dataset_path, index=False)

    combined["target"] = combined["target"].astype(int)
    splits = {}
    for name, part in combined.groupby("datasetSplit"):
        splits[name] = {
            "rows": int(len(part)),
            "positives": int(part["target"].sum()),
            "controls": int((part["target"] == 0).sum()),
            "groups": int(part["matchedCaseId"].nunique()),
        }
    per_case = Counter(int(value) for value in combined.loc[combined["target"].eq(0)].groupby("matchedCaseId").size())
    result = {
        "datasetVersion": args.dataset_version,
        "featureSetVersion": manifest["featureSetVersion"],
        "cohortDesign": "incidence-density-active-risk-set-case-control",
        "role": args.mode,
        "lookbackDays": int(manifest.get("lookbackDays", 90)),
        "rows": int(len(combined)),
        "positives": int(combined["target"].sum()),
        "controls": int((combined["target"] == 0).sum()),
        "matchedGroups": int(combined["matchedCaseId"].nunique()),
        "samplePrevalence": float(combined["target"].mean()),
        "controlsPerCaseDistribution": {str(key): value for key, value in sorted(per_case.items())},
        "excludedCasesWithoutCompleteControl": excluded_cases,
        "caseControlAddressOverlap": overlap,
        "excludedFileAddressOverlap": external_overlap,
        "temporalMismatches": temporal_mismatches,
        "nonFiniteFeatureValues": non_finite,
        "forbiddenFeatures": [],
        "labelLeakagePolicy": "Blacklist membership is target only and is not a feature",
        "pointInTimePolicy": "All features use only the lookback window before indexAtUtc",
        "splitUnit": "matchedCaseId",
        "splitStrategy": "chronological-grouped-70-15-15" if args.mode == "development" else "external-holdout-only",
        "splits": splits,
        "featureNames": feature_names,
        "sourceHashes": {
            "cases": sha256_file(cases_path),
            "controls": [{"file": str(path), "sha256": sha256_file(path)} for path in controls_paths],
            "excluded": exclude_hashes,
        },
        "datasetSha256": sha256_file(dataset_path),
        "trainingReady": args.mode == "development" and all(
            item["positives"] > 0 and item["controls"] > 0 for item in splits.values()
        ),
        "locked": args.mode == "external",
        "productionProbabilityReady": False,
        "generatedAtUtc": utc_now(),
    }
    manifest_name = "onchain-feature-manifest.json" if args.mode == "development" else "external-holdout-manifest.json"
    (output_dir / manifest_name).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    printable = {key: value for key, value in result.items() if key not in ("featureNames", "sourceHashes")}
    if args.mode == "external":
        # No mostrar métricas ni detalle del holdout más allá de los conteos.
        printable.pop("excludedCasesWithoutCompleteControl", None)
    print(json.dumps(printable, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
