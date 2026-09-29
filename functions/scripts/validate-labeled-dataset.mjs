#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {pathToFileURL} from "node:url";
import {FEATURE_NAMES} from "./build-point-in-time-snapshots.mjs";

const FORBIDDEN_FEATURE = /(blacklist|blocklist|ofac|tatum|risk.?score|risk.?level|label)/i;

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function validateLabeledDataset(directory) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "labeled_dataset_manifest.json");
  const ndjsonPath = path.join(root, "ts_labeled_snapshots.ndjson");
  const csvPath = path.join(root, "ts_labeled_snapshots.csv");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const counts = {
    includedRows: 0,
    positives: 0,
    negatives: 0,
    bySplit: {
      train: {rows: 0, positives: 0, negatives: 0},
      validation: {rows: 0, positives: 0, negatives: 0},
      test: {rows: 0, positives: 0, negatives: 0},
    },
  };
  const snapshotIds = new Set();
  const reader = readline.createInterface({input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity});
  for await (const line of reader) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    counts.includedRows += 1;
    if (snapshotIds.has(row.snapshotId)) throw new Error(`DUPLICATE_SNAPSHOT_ID:${row.snapshotId}`);
    snapshotIds.add(row.snapshotId);
    if (![0, 1].includes(row.targetBlacklistedFuture)) throw new Error(`INVALID_TARGET:${row.snapshotId}`);
    const featureNames = Object.keys(row.features).sort();
    if (JSON.stringify(featureNames) !== JSON.stringify([...FEATURE_NAMES].sort())) {
      throw new Error(`FEATURE_SCHEMA_MISMATCH:${row.snapshotId}`);
    }
    if (featureNames.some((name) => FORBIDDEN_FEATURE.test(name))) throw new Error(`FEATURE_LEAKAGE:${row.snapshotId}`);
    if (!Object.values(row.features).every(Number.isFinite)) throw new Error(`NON_FINITE_FEATURE:${row.snapshotId}`);
    const split = counts.bySplit[row.datasetSplit];
    if (!split) throw new Error(`INVALID_SPLIT:${row.snapshotId}`);
    split.rows += 1;
    if (row.targetBlacklistedFuture === 1) {
      counts.positives += 1;
      split.positives += 1;
      if (row.labelStatus !== "LABELED_POSITIVE" || !row.labelEvidence) throw new Error(`INVALID_POSITIVE:${row.snapshotId}`);
      const snapshotAt = Date.parse(row.snapshotAtUtc);
      const effectiveAt = Date.parse(row.labelEvidence.effectiveAtUtc);
      const windowEnd = Date.parse(row.labelWindowEndUtc);
      if (!(effectiveAt > snapshotAt && effectiveAt <= windowEnd)) throw new Error(`TEMPORAL_LEAKAGE:${row.snapshotId}`);
      if (!["ONCHAIN_EVENT", "OFFICIAL_PUBLICATION"].includes(row.labelEvidence.dateBasis)) {
        throw new Error(`INVALID_DATE_BASIS:${row.snapshotId}`);
      }
    } else {
      counts.negatives += 1;
      split.negatives += 1;
      if (row.labelStatus !== "LABELED_NEGATIVE_COMPLETE_WINDOW" || row.labelEvidence !== null) {
        throw new Error(`INVALID_NEGATIVE:${row.snapshotId}`);
      }
      if (Date.parse(row.labelWindowEndUtc) > Date.parse(manifest.coverageEndUtc)) {
        throw new Error(`INCOMPLETE_NEGATIVE_WINDOW:${row.snapshotId}`);
      }
    }
  }
  const ndjsonSha256 = await sha256(ndjsonPath);
  const csvSha256 = await sha256(csvPath);
  if (ndjsonSha256 !== manifest.files.ndjson.sha256) throw new Error("NDJSON_HASH_MISMATCH");
  if (csvSha256 !== manifest.files.csv.sha256) throw new Error("CSV_HASH_MISMATCH");
  if (JSON.stringify(counts) !== JSON.stringify({
    includedRows: manifest.counts.includedRows,
    positives: manifest.counts.positives,
    negatives: manifest.counts.negatives,
    bySplit: manifest.counts.bySplit,
  })) throw new Error("MANIFEST_COUNT_MISMATCH");
  const trainingReady = counts.positives > 0 && counts.negatives > 0 &&
    Object.values(counts.bySplit).every((split) => split.positives > 0 && split.negatives > 0);
  if (trainingReady !== manifest.trainingReady) throw new Error("READINESS_MISMATCH");
  const report = {
    ok: true,
    validatedAtUtc: new Date().toISOString(),
    ...counts,
    uniqueSnapshotIds: snapshotIds.size,
    trainingReady,
    ndjsonSha256,
    csvSha256,
  };
  await fsp.writeFile(path.join(root, "labeled_validation_report.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) {
    process.stderr.write("Uso: npm run dataset:validate-labels -- /ruta/dataset-etiquetado\n");
    process.exitCode = 1;
  } else {
    validateLabeledDataset(directory)
      .then((report) => process.stdout.write(JSON.stringify(report, null, 2) + "\n"))
      .catch((error) => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
