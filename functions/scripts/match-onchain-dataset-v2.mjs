#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

const DAY_MS = 86_400_000;
const MATCH_FEATURES = [
  "transferCount", "activeDays", "totalAmount", "uniqueCounterparties",
  "daysSinceLastTransfer",
];

function parseArgs(argv) {
  const options = {controlRatio: 3, dateCaliperDays: 90};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-dataset") options.baseDataset = argv[++index];
    else if (arg === "--base-manifest") options.baseManifest = argv[++index];
    else if (arg === "--candidate-dataset") options.candidateDataset = argv[++index];
    else if (arg === "--external-holdout") options.externalHoldout = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--control-ratio") options.controlRatio = Number(argv[++index]);
    else if (arg === "--date-caliper-days") options.dateCaliperDays = Number(argv[++index]);
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.baseDataset || !options.baseManifest || !options.candidateDataset ||
      !options.externalHoldout || !options.outputDir) {
    throw new Error("BASE_MANIFEST_CANDIDATES_HOLDOUT_OUTPUT_REQUIRED");
  }
  return options;
}

async function readCsv(filePath) {
  const rows = [];
  const reader = readline.createInterface({input: fs.createReadStream(path.resolve(filePath)), crlfDelay: Infinity});
  let headers;
  for await (const line of reader) {
    if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
  return {headers, rows};
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function transformed(row, feature) {
  const value = Number(row[feature] || 0);
  if (!Number.isFinite(value)) throw new Error(`NON_FINITE_MATCH_FEATURE:${feature}`);
  return Math.log1p(Math.max(0, Math.abs(value)));
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function std(values, average) {
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    Math.max(1, values.length - 1));
}

function standardizedMeanDifference(positives, controls, feature) {
  const a = positives.map((row) => transformed(row, feature));
  const b = controls.map((row) => transformed(row, feature));
  const meanA = mean(a);
  const meanB = mean(b);
  const pooled = Math.sqrt((std(a, meanA) ** 2 + std(b, meanB) ** 2) / 2);
  return pooled ? (meanA - meanB) / pooled : 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [base, candidates, holdout] = await Promise.all([
    readCsv(options.baseDataset), readCsv(options.candidateDataset),
    readCsv(options.externalHoldout),
  ]);
  const manifest = JSON.parse(await fsp.readFile(path.resolve(options.baseManifest), "utf8"));
  const holdoutAddresses = new Set(holdout.rows.map((row) => row.address));
  const positives = base.rows.filter((row) => Number(row.target) === 1 && !holdoutAddresses.has(row.address));
  const controlMap = new Map();
  for (const row of [...base.rows, ...candidates.rows]) {
    if (Number(row.target) !== 0 || holdoutAddresses.has(row.address)) continue;
    controlMap.set(row.address, row);
  }
  const controls = [...controlMap.values()];
  const stats = {};
  for (const feature of MATCH_FEATURES) {
    const values = controls.map((row) => transformed(row, feature));
    const average = mean(values);
    stats[feature] = {mean: average, std: std(values, average) || 1};
  }
  function distance(positive, control) {
    let total = 0;
    for (const feature of MATCH_FEATURES) {
      const a = (transformed(positive, feature) - stats[feature].mean) / stats[feature].std;
      const b = (transformed(control, feature) - stats[feature].mean) / stats[feature].std;
      total += (a - b) ** 2;
    }
    const dateDays = Math.abs(Date.parse(positive.indexAtUtc) - Date.parse(control.indexAtUtc)) / DAY_MS;
    total += 0.5 * (dateDays / options.dateCaliperDays) ** 2;
    return total;
  }
  const rarity = (row) => MATCH_FEATURES.reduce((sum, feature) => {
    const z = (transformed(row, feature) - stats[feature].mean) / stats[feature].std;
    return sum + z ** 2;
  }, 0);
  const orderedPositives = [...positives].sort((a, b) => rarity(b) - rarity(a));
  const available = new Map(controls.map((row) => [row.address, row]));
  const matches = new Map();
  for (const positive of orderedPositives) {
    const eligible = [...available.values()]
      .filter((control) => Math.abs(Date.parse(positive.indexAtUtc) -
        Date.parse(control.indexAtUtc)) <= options.dateCaliperDays * DAY_MS)
      .map((control) => ({control, distance: distance(positive, control)}))
      .sort((a, b) => a.distance - b.distance || a.control.address.localeCompare(b.control.address))
      .slice(0, options.controlRatio);
    if (eligible.length < options.controlRatio) {
      throw new Error(`INSUFFICIENT_MATCHES:${positive.address}:${eligible.length}`);
    }
    matches.set(positive.address, eligible);
    for (const item of eligible) available.delete(item.control.address);
  }
  const groups = [...positives].sort((a, b) => Date.parse(a.indexAtUtc) - Date.parse(b.indexAtUtc));
  const trainEnd = Math.floor(groups.length * 0.70);
  const validationEnd = Math.floor(groups.length * 0.85);
  const split = new Map(groups.map((row, index) => [
    row.address,
    index < trainEnd ? "train" : index < validationEnd ? "validation" : "test",
  ]));
  const featureNames = manifest.featureNames;
  const outputRows = [];
  const distances = [];
  for (const positive of groups) {
    const matchedCaseId = positive.cohortId;
    outputRows.push({...positive, matchedCaseId, datasetSplit: split.get(positive.address)});
    for (const item of matches.get(positive.address)) {
      distances.push(item.distance);
      outputRows.push({
        ...item.control,
        matchedCaseId,
        datasetSplit: split.get(positive.address),
      });
    }
  }
  const matchedControls = outputRows.filter((row) => Number(row.target) === 0);
  const balance = Object.fromEntries(MATCH_FEATURES.map((feature) => [feature, {
    before: standardizedMeanDifference(positives, controls, feature),
    after: standardizedMeanDifference(positives, matchedControls, feature),
  }]));
  const maximumAbsoluteSmd = Math.max(...Object.values(balance).map((item) => Math.abs(item.after)));
  const headers = ["cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target", ...featureNames];
  const lines = [headers.join(",")];
  for (const row of outputRows) lines.push(headers.map((header) => csvValue(row[header])).join(","));
  const outputDir = path.resolve(options.outputDir);
  await fsp.mkdir(outputDir, {recursive: true});
  const datasetPath = path.join(outputDir, "onchain-feature-dataset-v2.csv");
  await fsp.writeFile(datasetPath, `${lines.join("\n")}\n`);
  const splitCounts = outputRows.reduce((result, row) => {
    result[row.datasetSplit] ||= {rows: 0, positives: 0, controls: 0};
    result[row.datasetSplit].rows += 1;
    if (Number(row.target) === 1) result[row.datasetSplit].positives += 1;
    else result[row.datasetSplit].controls += 1;
    return result;
  }, {});
  const outputManifest = {
    datasetVersion: "tronsentinel-onchain-features-2.0.0",
    featureSetVersion: manifest.featureSetVersion,
    cohortDesign: "onchain-feature-matched-case-control",
    lookbackDays: manifest.lookbackDays,
    featureNames,
    rows: outputRows.length,
    positives: positives.length,
    controls: matchedControls.length,
    excludedExternalHoldout: holdoutAddresses.size,
    matching: {
      controlRatio: options.controlRatio,
      dateCaliperDays: options.dateCaliperDays,
      features: MATCH_FEATURES,
      balance,
      maximumAbsoluteSmd,
      distanceMean: mean(distances),
      distanceMax: Math.max(...distances),
    },
    splitUnit: "matchedCaseId",
    splitStrategy: "chronological-70-15-15",
    splits: splitCounts,
    trainingReady: outputRows.length === positives.length * (options.controlRatio + 1) &&
      maximumAbsoluteSmd <= 0.10,
    generatedAtUtc: new Date().toISOString(),
  };
  await fsp.writeFile(
    path.join(outputDir, "onchain-feature-manifest-v2.json"),
    `${JSON.stringify(outputManifest, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ok: true, outputDir, ...outputManifest}, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
