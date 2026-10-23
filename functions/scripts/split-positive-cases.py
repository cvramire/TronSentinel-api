#!/usr/bin/env python3
"""Separa casos positivos en desarrollo y holdout externo por fecha índice.

Los casos más recientes van al holdout externo. Debe ejecutarse antes de
construir controles o mirar métricas, y el holdout no se vuelve a abrir hasta
confirm-onchain-test.py --partition external-holdout.
"""

import argparse
import json
from pathlib import Path

import pandas as pd

from onchain_governance import sha256_file, utc_now


def parse_args():
    parser = argparse.ArgumentParser(description="Separa positivos en desarrollo y holdout externo")
    parser.add_argument("--features", required=True, help="onchain-feature-dataset.csv de la cohorte de positivos")
    parser.add_argument("--output-dir", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--external-count", type=int, help="Cantidad de casos más recientes para el holdout externo")
    group.add_argument("--external-from", help="Fecha ISO: casos con indexAtUtc >= fecha van al holdout externo")
    parser.add_argument("--min-development", type=int, default=200)
    return parser.parse_args()


def main():
    args = parse_args()
    source = Path(args.features).resolve()
    frame = pd.read_csv(source, low_memory=False)
    positives = frame.loc[frame["target"].astype(int).eq(1)].copy()
    if positives.empty:
        raise SystemExit("NO_POSITIVE_CASES")
    if positives["address"].duplicated().any():
        positives = positives.sort_values("indexAtUtc").drop_duplicates("address", keep="first")
    positives["_index"] = pd.to_datetime(positives["indexAtUtc"], utc=True)
    positives = positives.sort_values(["_index", "cohortId"]).reset_index(drop=True)

    if args.external_count is not None:
        if not 0 < args.external_count < len(positives):
            raise SystemExit("EXTERNAL_COUNT_OUT_OF_RANGE")
        external_mask = positives.index >= len(positives) - args.external_count
    else:
        external_mask = (positives["_index"] >= pd.Timestamp(args.external_from, tz="UTC")).to_numpy()
    development = positives.loc[~external_mask].drop(columns="_index")
    external = positives.loc[external_mask].drop(columns="_index")
    if len(development) < args.min_development:
        raise SystemExit(f"TOO_FEW_DEVELOPMENT_CASES:{len(development)}")
    if external.empty:
        raise SystemExit("NO_EXTERNAL_CASES")
    if pd.to_datetime(development["indexAtUtc"], utc=True).max() > pd.to_datetime(external["indexAtUtc"], utc=True).min():
        raise SystemExit("TEMPORAL_OVERLAP_BETWEEN_DEVELOPMENT_AND_EXTERNAL")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_path = output_dir / "cases-development.csv"
    external_path = output_dir / "cases-external.csv"
    development.to_csv(development_path, index=False)
    external.to_csv(external_path, index=False)
    summary = {
        "ok": True,
        "source": str(source),
        "sourceSha256": sha256_file(source),
        "rule": "chronological: most recent cases go to the external holdout",
        "development": {
            "cases": int(len(development)),
            "fromUtc": str(development["indexAtUtc"].min()),
            "toUtc": str(development["indexAtUtc"].max()),
            "sha256": sha256_file(development_path),
        },
        "external": {
            "cases": int(len(external)),
            "fromUtc": str(external["indexAtUtc"].min()),
            "toUtc": str(external["indexAtUtc"].max()),
            "sha256": sha256_file(external_path),
            "locked": True,
        },
        "generatedAtUtc": utc_now(),
    }
    (output_dir / "case-split-summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
