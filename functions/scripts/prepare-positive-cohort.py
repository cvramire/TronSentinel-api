#!/usr/bin/env python3
"""Cohorte de casos positivos para un risk set (sin controles).

Reemplaza a prepare-onchain-cohort.mjs cuando los controles se obtienen con
prepare-risk-set-controls-v5.mjs, que no requiere archivo de eventos.

- La fecha índice es la PRIMERA inclusión conocida (ADD) de la dirección.
  Solo entran direcciones cuya primera inclusión cae en [from, to].
- Selección round-robin por mes, ordenada por sha256(seed|address), igual que
  la cohorte v1 (cohortId = case_<16 hex>).
- --exclude descarta direcciones usadas en cohortes anteriores.

Salida compatible con fetch-onchain-history.mjs y consolidate-onchain-history.mjs.
"""

import argparse
import csv
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from onchain_governance import sha256_file, utc_now


HEADERS = ["cohortId", "matchedCaseId", "address", "target", "indexAtUtc", "lookbackEndExclusiveUtc", "evidenceRef", "source"]


def parse_args():
    parser = argparse.ArgumentParser(description="Cohorte de positivos para risk set")
    parser.add_argument("--labels", required=True, help="blacklist-label-events-final.csv")
    parser.add_argument("--from", dest="from_utc", required=True)
    parser.add_argument("--to", dest="to_utc", required=True)
    parser.add_argument("--positive-limit", type=int, default=700)
    parser.add_argument("--seed", required=True)
    parser.add_argument("--exclude", action="append", default=[], help="CSV con columna address (repetible)")
    parser.add_argument("--output-dir", required=True)
    return parser.parse_args()


def parse_time(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def rank(seed, *values):
    return hashlib.sha256("|".join([seed, *values]).encode("utf-8")).hexdigest()


def main():
    args = parse_args()
    start, end = parse_time(args.from_utc), parse_time(args.to_utc)
    if start >= end:
        raise SystemExit("INVALID_DATE_RANGE")

    first_add = {}
    with open(args.labels, newline="", encoding="utf-8") as source:
        for row in csv.DictReader(source):
            if row.get("action") != "ADD":
                continue
            moment = parse_time(row["effectiveAtUtc"])
            previous = first_add.get(row["address"])
            if previous is None or moment < previous[0]:
                first_add[row["address"]] = (moment, row.get("evidenceRef", ""), row.get("source", ""))

    excluded = set()
    exclude_hashes = []
    for item in args.exclude:
        path = Path(item).expanduser().resolve()
        with open(path, newline="", encoding="utf-8") as source:
            excluded |= {row["address"] for row in csv.DictReader(source) if row.get("address")}
        exclude_hashes.append({"file": str(path), "sha256": sha256_file(path)})

    pool = [
        {"address": address, "index": moment, "evidenceRef": evidence, "source": source}
        for address, (moment, evidence, source) in first_add.items()
        if start <= moment <= end and address not in excluded
    ]
    reincluded = sum(1 for address, (moment, *_rest) in first_add.items() if moment < start and address not in excluded)
    by_month = defaultdict(list)
    for item in pool:
        by_month[item["index"].strftime("%Y-%m")].append(item)
    for key, values in by_month.items():
        values.sort(key=lambda item: rank(args.seed, item["address"]))
    selected, cursor = [], 0
    months = sorted(by_month)
    while len(selected) < min(args.positive_limit, len(pool)):
        added = False
        for key in months:
            if cursor < len(by_month[key]):
                selected.append(by_month[key][cursor])
                added = True
                if len(selected) == args.positive_limit:
                    break
        if not added:
            break
        cursor += 1

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    cohort_path = output_dir / "onchain-cohort.csv"
    selected.sort(key=lambda item: (item["index"], item["address"]))
    with open(cohort_path, "w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(HEADERS)
        for item in selected:
            case_id = f"case_{rank(args.seed, item['address'])[:16]}"
            writer.writerow([case_id, case_id, item["address"], 1, iso(item["index"]), iso(item["index"]),
                             item["evidenceRef"], item["source"]])
    counts = defaultdict(int)
    for item in selected:
        counts[item["index"].strftime("%Y-%m")] += 1
    plan = {
        "version": "tronsentinel-positive-cohort-1.0.0",
        "seed": args.seed,
        "indexPolicy": "first known ADD per address",
        "fromUtc": iso(start), "toUtc": iso(end),
        "positivePool": len(pool),
        "positives": len(selected),
        "controls": 0,
        "byMonth": dict(sorted(counts.items())),
        "excludedAddresses": len(excluded),
        "excludeFiles": exclude_hashes,
        "addressesFirstAddedBeforeWindow": reincluded,
        "labelsSha256": sha256_file(args.labels),
        "cohortSha256": sha256_file(cohort_path),
        "generatedAtUtc": utc_now(),
    }
    (output_dir / "onchain-cohort-plan.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in plan.items() if k != "excludeFiles"}, indent=2))


if __name__ == "__main__":
    main()
