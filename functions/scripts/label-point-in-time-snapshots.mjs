#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {pathToFileURL} from "node:url";
import {FEATURE_NAMES, parseCsvLine} from "./build-point-in-time-snapshots.mjs";

const DAY_MS = 86_400_000;
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const ACCEPTED_CATEGORIES = new Set(["BLACKLIST", "SANCTIONED"]);
const ACCEPTED_DATE_BASES = new Set(["ONCHAIN_EVENT", "OFFICIAL_PUBLICATION"]);
const FORBIDDEN_EVIDENCE_FIELDS = /(legacy.*risk|risk.*score|risk.*level|pseudo.*label)/i;

function csvValue(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function requiredText(row, field, rowNumber) {
  const value = String(row[field] ?? "").trim();
  if (!value) throw new Error(`MISSING_${field.toUpperCase()}_AT_LABEL_ROW:${rowNumber}`);
  return value;
}

function utcMs(value, field, rowNumber) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`INVALID_${field.toUpperCase()}_AT_LABEL_ROW:${rowNumber}`);
  return parsed;
}

export function normalizeEvidence(row, rowNumber = 1) {
  const forbidden = Object.keys(row).find((field) => FORBIDDEN_EVIDENCE_FIELDS.test(field));
  if (forbidden) throw new Error(`FORBIDDEN_EVIDENCE_FIELD:${forbidden}`);
  const address = requiredText(row, "address", rowNumber);
  if (!TRON_ADDRESS.test(address)) throw new Error(`INVALID_ADDRESS_AT_LABEL_ROW:${rowNumber}`);
  const category = requiredText(row, "category", rowNumber).toUpperCase();
  if (!ACCEPTED_CATEGORIES.has(category)) throw new Error(`UNSUPPORTED_CATEGORY_AT_LABEL_ROW:${rowNumber}`);
  const action = requiredText(row, "action", rowNumber).toUpperCase();
  if (action !== "ADD") throw new Error(`UNSUPPORTED_ACTION_AT_LABEL_ROW:${rowNumber}`);
  const dateBasis = requiredText(row, "dateBasis", rowNumber).toUpperCase();
  if (!ACCEPTED_DATE_BASES.has(dateBasis)) throw new Error(`UNSUPPORTED_DATE_BASIS_AT_LABEL_ROW:${rowNumber}`);
  const effectiveAtUtc = requiredText(row, "effectiveAtUtc", rowNumber);
  const observedAtUtc = requiredText(row, "observedAtUtc", rowNumber);
  const effectiveAtMs = utcMs(effectiveAtUtc, "effectiveAtUtc", rowNumber);
  const observedAtMs = utcMs(observedAtUtc, "observedAtUtc", rowNumber);
  if (observedAtMs < effectiveAtMs) throw new Error(`OBSERVED_BEFORE_EFFECTIVE_AT_LABEL_ROW:${rowNumber}`);
  const confidence = Number(row.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`INVALID_CONFIDENCE_AT_LABEL_ROW:${rowNumber}`);
  }
  return {
    address,
    chain: String(row.chain || "tron-mainnet").trim(),
    category,
    action,
    dateBasis,
    effectiveAtUtc: new Date(effectiveAtMs).toISOString(),
    effectiveAtMs,
    observedAtUtc: new Date(observedAtMs).toISOString(),
    observedAtMs,
    source: requiredText(row, "source", rowNumber),
    evidenceRef: requiredText(row, "evidenceRef", rowNumber),
    confidence,
  };
}

async function readCsv(filePath) {
  const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
  let headers = null;
  const rows = [];
  for await (const line of reader) {
    if (!headers) {
      headers = parseCsvLine(line.replace(/^\uFEFF/, ""));
      continue;
    }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
  return rows;
}

async function readNdjson(filePath) {
  const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
  const rows = [];
  for await (const line of reader) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function loadEvidence(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let rows;
  if (extension === ".csv") rows = await readCsv(filePath);
  else if ([".ndjson", ".jsonl"].includes(extension)) rows = await readNdjson(filePath);
  else if (extension === ".json") {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    rows = Array.isArray(parsed) ? parsed : parsed.labels;
  } else throw new Error("LABELS_MUST_BE_CSV_JSON_OR_NDJSON");
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("LABEL_EVIDENCE_IS_EMPTY");
  return rows.map((row, index) => normalizeEvidence(row, index + 2));
}

function evidenceIndex(evidence) {
  const byAddress = new Map();
  const duplicates = new Set();
  for (const item of evidence) {
    const identity = `${item.address}|${item.effectiveAtUtc}|${item.source}|${item.evidenceRef}`;
    if (duplicates.has(identity)) continue;
    duplicates.add(identity);
    if (!byAddress.has(item.address)) byAddress.set(item.address, []);
    byAddress.get(item.address).push(item);
  }
  for (const events of byAddress.values()) events.sort((a, b) => a.effectiveAtMs - b.effectiveAtMs);
  return {byAddress, uniqueEvidenceCount: duplicates.size};
}

export function classifySnapshot(snapshotAtMs, labelEvents, horizonDays, coverageEndMs) {
  const horizonEndMs = snapshotAtMs + horizonDays * DAY_MS;
  const first = labelEvents?.[0] || null;
  if (first && first.effectiveAtMs <= snapshotAtMs) {
    return {target: null, status: "EXCLUDED_ALREADY_LISTED", horizonEndMs, matched: first};
  }
  const future = labelEvents?.find((item) =>
    item.effectiveAtMs > snapshotAtMs && item.effectiveAtMs <= horizonEndMs,
  );
  if (future) return {target: 1, status: "LABELED_POSITIVE", horizonEndMs, matched: future};
  if (horizonEndMs <= coverageEndMs) {
    return {target: 0, status: "LABELED_NEGATIVE_COMPLETE_WINDOW", horizonEndMs, matched: null};
  }
  return {target: null, status: "CENSORED_INCOMPLETE_FOLLOWUP", horizonEndMs, matched: null};
}

function parseArgs(argv) {
  const options = {snapshotsDir: "", labels: "", outputDir: "", coverageEnd: "", horizonDays: 90};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--snapshots-dir") options.snapshotsDir = argv[++index] || "";
    else if (arg === "--labels") options.labels = argv[++index] || "";
    else if (arg === "--output-dir") options.outputDir = argv[++index] || "";
    else if (arg === "--coverage-end") options.coverageEnd = argv[++index] || "";
    else if (arg === "--horizon-days") options.horizonDays = Number(argv[++index]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  return options;
}

function usage() {
  return `Uso:\n  npm run dataset:label -- \\\n+    --snapshots-dir /ruta/tronsentinel-point-in-time-v0.2.0 \\\n+    --labels /ruta/blacklist-label-events.csv \\\n+    --coverage-end 2026-09-30T23:59:59Z \\\n+    --horizon-days 90 \\\n+    --output-dir /ruta/tronsentinel-labeled\n`;
}

async function writeLabeledDataset(options) {
  const snapshotsDir = path.resolve(options.snapshotsDir);
  const labelsPath = path.resolve(options.labels);
  const outputDir = path.resolve(options.outputDir);
  const coverageEndMs = Date.parse(options.coverageEnd);
  if (!Number.isFinite(coverageEndMs)) throw new Error("VALID_COVERAGE_END_REQUIRED");
  if (!Number.isInteger(options.horizonDays) || options.horizonDays < 1 || options.horizonDays > 365) {
    throw new Error("HORIZON_DAYS_MUST_BE_INTEGER_1_TO_365");
  }
  const sourceManifestPath = path.join(snapshotsDir, "dataset_manifest.json");
  const snapshotsPath = path.join(snapshotsDir, "ts_feature_snapshots.ndjson");
  const sourceManifest = JSON.parse(await fsp.readFile(sourceManifestPath, "utf8"));
  const evidence = await loadEvidence(labelsPath);
  const indexed = evidenceIndex(evidence);
  await fsp.mkdir(outputDir, {recursive: true});

  const ndjsonPath = path.join(outputDir, "ts_labeled_snapshots.ndjson");
  const csvPath = path.join(outputDir, "ts_labeled_snapshots.csv");
  const ndjson = fs.createWriteStream(ndjsonPath);
  const csv = fs.createWriteStream(csvPath);
  csv.write([
    "snapshotId", "address", "snapshotAtUtc", "datasetSplit", "targetBlacklistedFuture",
    "labelStatus", "predictionHorizonDays", "labelEffectiveAtUtc", "labelSource",
    "labelEvidenceRef", ...FEATURE_NAMES,
  ].join(",") + "\n");

  const counts = {
    totalSourceRows: 0,
    includedRows: 0,
    positives: 0,
    negatives: 0,
    censored: 0,
    excludedAlreadyListed: 0,
    bySplit: {
      train: {rows: 0, positives: 0, negatives: 0},
      validation: {rows: 0, positives: 0, negatives: 0},
      test: {rows: 0, positives: 0, negatives: 0},
    },
  };
  const reader = readline.createInterface({input: fs.createReadStream(snapshotsPath), crlfDelay: Infinity});
  for await (const line of reader) {
    if (!line.trim()) continue;
    counts.totalSourceRows += 1;
    const snapshot = JSON.parse(line);
    const classification = classifySnapshot(
      snapshot.snapshotAtMs,
      indexed.byAddress.get(snapshot.address),
      options.horizonDays,
      coverageEndMs,
    );
    if (classification.status === "EXCLUDED_ALREADY_LISTED") counts.excludedAlreadyListed += 1;
    if (classification.status === "CENSORED_INCOMPLETE_FOLLOWUP") counts.censored += 1;
    if (classification.target == null) continue;
    counts.includedRows += 1;
    const positive = classification.target === 1;
    if (positive) counts.positives += 1;
    else counts.negatives += 1;
    const splitCounts = counts.bySplit[snapshot.datasetSplit];
    if (!splitCounts) throw new Error(`INVALID_DATASET_SPLIT:${snapshot.datasetSplit}`);
    splitCounts.rows += 1;
    if (positive) splitCounts.positives += 1;
    else splitCounts.negatives += 1;
    const matched = classification.matched;
    const labeled = {
      ...snapshot,
      labelStatus: classification.status,
      targetBlacklistedFuture: classification.target,
      predictionHorizonDays: options.horizonDays,
      labelWindowEndUtc: new Date(classification.horizonEndMs).toISOString(),
      labelEvidence: matched ? {
        effectiveAtUtc: matched.effectiveAtUtc,
        observedAtUtc: matched.observedAtUtc,
        source: matched.source,
        category: matched.category,
        dateBasis: matched.dateBasis,
        confidence: matched.confidence,
        evidenceRef: matched.evidenceRef,
      } : null,
    };
    ndjson.write(JSON.stringify(labeled) + "\n");
    csv.write([
      labeled.snapshotId,
      labeled.address,
      labeled.snapshotAtUtc,
      labeled.datasetSplit,
      labeled.targetBlacklistedFuture,
      labeled.labelStatus,
      labeled.predictionHorizonDays,
      matched?.effectiveAtUtc || "",
      matched?.source || "",
      matched?.evidenceRef || "",
      ...FEATURE_NAMES.map((name) => labeled.features[name]),
    ].map(csvValue).join(",") + "\n");
  }
  await Promise.all([
    new Promise((resolve, reject) => ndjson.end((error) => error ? reject(error) : resolve())),
    new Promise((resolve, reject) => csv.end((error) => error ? reject(error) : resolve())),
  ]);

  const allSplitsUsable = Object.values(counts.bySplit).every((split) =>
    split.positives > 0 && split.negatives > 0,
  );
  const manifest = {
    datasetVersion: "tronsentinel-point-in-time-0.3.0-labeled",
    generatedAtUtc: new Date().toISOString(),
    sourceDatasetVersion: sourceManifest.datasetVersion,
    sourceManifestSha256: await fileSha256(sourceManifestPath),
    sourceSnapshotsSha256: await fileSha256(snapshotsPath),
    labelEvidenceFile: path.basename(labelsPath),
    labelEvidenceSha256: await fileSha256(labelsPath),
    labelEvidenceRows: evidence.length,
    uniqueLabelEvidenceRows: indexed.uniqueEvidenceCount,
    targetDefinition: `Confirmed BLACKLIST or SANCTIONED ADD event in (snapshotAt, snapshotAt + ${options.horizonDays} days].`,
    negativeDefinition: "No confirmed ADD event in a fully observed prediction window.",
    coverageEndUtc: new Date(coverageEndMs).toISOString(),
    predictionHorizonDays: options.horizonDays,
    featureSetVersion: sourceManifest.featureSetVersion,
    featureNames: FEATURE_NAMES,
    temporalSplit: sourceManifest.temporalSplit,
    counts,
    trainingReady: counts.positives > 0 && counts.negatives > 0 && allSplitsUsable,
    readinessReason: allSplitsUsable ? "BOTH_CLASSES_PRESENT_IN_EVERY_TEMPORAL_SPLIT" : "EACH_TEMPORAL_SPLIT_REQUIRES_POSITIVE_AND_NEGATIVE_ROWS",
    files: {
      ndjson: {name: path.basename(ndjsonPath), sha256: await fileSha256(ndjsonPath)},
      csv: {name: path.basename(csvPath), sha256: await fileSha256(csvPath)},
    },
  };
  await fsp.writeFile(path.join(outputDir, "labeled_dataset_manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) return process.stdout.write(usage());
  if (!options.snapshotsDir || !options.labels || !options.outputDir) {
    throw new Error("SNAPSHOTS_LABELS_AND_OUTPUT_REQUIRED");
  }
  const manifest = await writeLabeledDataset(options);
  process.stdout.write(JSON.stringify({ok: true, outputDir: path.resolve(options.outputDir), ...manifest.counts, trainingReady: manifest.trainingReady}, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
