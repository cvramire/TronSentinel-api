#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const options = {limit: 3000, followupDays: 90, seed: "tronsentinel-control-pool-v2"};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--control-source") options.controlSource = argv[++index];
    else if (arg === "--labels") options.labels = argv[++index];
    else if (arg === "--training-cohort") options.trainingCohort = argv[++index];
    else if (arg === "--external-holdout") options.externalHoldout = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--followup-days") options.followupDays = Number(argv[++index]);
    else if (arg === "--seed") options.seed = argv[++index];
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.controlSource || !options.labels || !options.trainingCohort ||
      !options.externalHoldout || !options.output) {
    throw new Error("CONTROL_LABELS_TRAINING_HOLDOUT_OUTPUT_REQUIRED");
  }
  return options;
}

async function readCsv(filePath) {
  const rows = [];
  const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
  let headers;
  for await (const line of reader) {
    if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
  return rows;
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function hash(seed, value) {
  return crypto.createHash("sha256").update(`${seed}|${value}`).digest("hex");
}

function isoDate(value) {
  const parsed = Date.parse(String(value || "").replace(" ", "T"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function activityBand(eventCount) {
  return Math.min(12, Math.floor(Math.log2(Math.max(1, eventCount))));
}

function roundRobin(groups, limit) {
  const keys = [...groups.keys()].sort();
  const selected = [];
  let cursor = 0;
  while (selected.length < limit) {
    let added = false;
    for (const key of keys) {
      const row = groups.get(key)[cursor];
      if (row) {
        selected.push(row);
        added = true;
        if (selected.length === limit) break;
      }
    }
    if (!added) break;
    cursor += 1;
  }
  return selected;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [source, labels, training, holdout] = await Promise.all([
    readCsv(path.resolve(options.controlSource)), readCsv(path.resolve(options.labels)),
    readCsv(path.resolve(options.trainingCohort)), readCsv(path.resolve(options.externalHoldout)),
  ]);
  const excluded = new Set([
    ...labels.map((row) => row.address),
    ...training.map((row) => row.address),
    ...holdout.map((row) => row.address),
  ]);
  const latestLabelMs = Math.max(...labels.map((row) => Date.parse(row.effectiveAtUtc) || 0));
  const unique = new Map();
  for (const row of source) {
    if (excluded.has(row.address) || unique.has(row.address)) continue;
    const indexAtUtc = isoDate(row.last_event_utc);
    const indexAtMs = Date.parse(indexAtUtc);
    const eventCount = Number(row.event_count || 0);
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(row.address) ||
        !Number.isFinite(indexAtMs) || eventCount <= 0 ||
        latestLabelMs - indexAtMs < options.followupDays * DAY_MS) continue;
    unique.set(row.address, {...row, indexAtUtc, indexAtMs, eventCount});
  }
  const groups = new Map();
  for (const row of unique.values()) {
    const key = `${row.indexAtUtc.slice(0, 7)}|${activityBand(row.eventCount)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => hash(options.seed, a.address).localeCompare(hash(options.seed, b.address)));
  }
  const selected = roundRobin(groups, options.limit);
  if (selected.length < options.limit) throw new Error(`INSUFFICIENT_CONTROL_POOL:${selected.length}`);
  const headers = [
    "cohortId", "matchedCaseId", "address", "target", "indexAtUtc",
    "lookbackEndExclusiveUtc", "evidenceRef", "source",
  ];
  const lines = [headers.join(",")];
  for (const row of selected) {
    const id = hash(options.seed, row.address).slice(0, 16);
    lines.push([
      `pool_control_${id}`, `pool_control_${id}`, row.address, 0,
      row.indexAtUtc, row.indexAtUtc, "", "WALLET_ALERT_CONTROL_POOL_V2",
    ].map(csvValue).join(","));
  }
  const output = path.resolve(options.output);
  await fsp.mkdir(path.dirname(output), {recursive: true});
  await fsp.writeFile(output, `${lines.join("\n")}\n`);
  const byMonth = selected.reduce((result, row) => {
    const key = row.indexAtUtc.slice(0, 7);
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const summary = {
    ok: true,
    version: "tronsentinel-onchain-control-pool-v2",
    output,
    controls: selected.length,
    excludedTrainingAndHoldout: true,
    followupDays: options.followupDays,
    latestLabelAtUtc: new Date(latestLabelMs).toISOString(),
    strata: groups.size,
    byMonth,
    generatedAtUtc: new Date().toISOString(),
  };
  await fsp.writeFile(`${output}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
