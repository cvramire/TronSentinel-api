#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

function parseArgs(argv) {
  const options = {positiveLimit: 500, controlRatio: 3, seed: "tronsentinel-onchain-v1"};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--labels") options.labels = argv[++index];
    else if (arg === "--events") options.events = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--from") options.from = argv[++index];
    else if (arg === "--to") options.to = argv[++index];
    else if (arg === "--positive-limit") options.positiveLimit = Number(argv[++index]);
    else if (arg === "--control-ratio") options.controlRatio = Number(argv[++index]);
    else if (arg === "--seed") options.seed = argv[++index];
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.labels || !options.events || !options.outputDir || !options.from || !options.to) {
    throw new Error("LABELS_EVENTS_OUTPUT_FROM_TO_REQUIRED");
  }
  if (!Number.isInteger(options.positiveLimit) || options.positiveLimit < 1) throw new Error("INVALID_POSITIVE_LIMIT");
  if (!Number.isInteger(options.controlRatio) || options.controlRatio < 1 || options.controlRatio > 20) throw new Error("INVALID_CONTROL_RATIO");
  return options;
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rank(seed, ...values) {
  return crypto.createHash("sha256").update([seed, ...values].join("|")).digest("hex");
}

async function readCsv(filePath, onRow) {
  const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
  let headers;
  for await (const line of reader) {
    if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    await onRow(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
}

function month(timestampMs) { return new Date(timestampMs).toISOString().slice(0, 7); }

export function roundRobinByMonth(items, limit, seed) {
  const groups = new Map();
  for (const item of items) {
    const key = month(item.indexAtMs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const values of groups.values()) values.sort((a, b) => rank(seed, a.address).localeCompare(rank(seed, b.address)));
  const keys = [...groups.keys()].sort();
  const selected = [];
  let cursor = 0;
  while (selected.length < limit) {
    let added = false;
    for (const key of keys) {
      const candidate = groups.get(key)[cursor];
      if (candidate) { selected.push(candidate); added = true; if (selected.length === limit) break; }
    }
    if (!added) break;
    cursor += 1;
  }
  return selected;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fromMs = Date.parse(options.from);
  const toMs = Date.parse(options.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) throw new Error("INVALID_DATE_RANGE");
  const blacklisted = new Set();
  const positiveByAddress = new Map();
  await readCsv(path.resolve(options.labels), async (row) => {
    const timestampMs = Date.parse(row.effectiveAtUtc);
    blacklisted.add(row.address);
    if (timestampMs < fromMs || timestampMs > toMs) return;
    const previous = positiveByAddress.get(row.address);
    if (!previous || timestampMs < previous.indexAtMs) {
      positiveByAddress.set(row.address, {
        address: row.address, target: 1, indexAtMs: timestampMs,
        evidenceRef: row.evidenceRef || "", source: row.source || "",
      });
    }
  });
  const positivePool = [...positiveByAddress.values()];
  const positives = roundRobinByMonth(positivePool, Math.min(options.positiveLimit, positivePool.length), options.seed);
  const controlsByMonth = new Map();
  const seenControl = new Set();
  await readCsv(path.resolve(options.events), async (row) => {
    if (blacklisted.has(row.address)) return;
    const timestampMs = Date.parse(row.event_timestamp_utc);
    if (timestampMs < fromMs || timestampMs > toMs) return;
    const key = `${month(timestampMs)}|${row.address}`;
    if (seenControl.has(key)) return;
    seenControl.add(key);
    const group = month(timestampMs);
    if (!controlsByMonth.has(group)) controlsByMonth.set(group, []);
    controlsByMonth.get(group).push({address: row.address, target: 0, indexAtMs: timestampMs, evidenceRef: "", source: "WALLET_ALERT_ACTIVE_CONTROL"});
  });
  const usedControls = new Set();
  const controlCursors = new Map();
  for (const [key, values] of controlsByMonth) {
    values.sort((a, b) => rank(options.seed, key, a.address).localeCompare(rank(options.seed, key, b.address)));
  }
  const cohort = [];
  for (const positive of positives) {
    const cohortId = `case_${rank(options.seed, positive.address).slice(0, 16)}`;
    cohort.push({...positive, cohortId, matchedCaseId: cohortId});
    const key = month(positive.indexAtMs);
    const candidates = controlsByMonth.get(key) || [];
    let cursor = controlCursors.get(key) || 0;
    const selectedControls = [];
    while (cursor < candidates.length && selectedControls.length < options.controlRatio) {
      const candidate = candidates[cursor++];
      if (!usedControls.has(candidate.address)) selectedControls.push(candidate);
    }
    controlCursors.set(key, cursor);
    if (selectedControls.length < options.controlRatio) throw new Error(`INSUFFICIENT_CONTROLS_FOR:${positive.address}`);
    for (const control of selectedControls) {
      usedControls.add(control.address);
      cohort.push({...control, cohortId: `control_${rank(options.seed, positive.address, control.address).slice(0, 16)}`, matchedCaseId: cohortId});
    }
  }
  const outputDir = path.resolve(options.outputDir);
  await fsp.mkdir(outputDir, {recursive: true});
  const headers = ["cohortId", "matchedCaseId", "address", "target", "indexAtUtc", "lookbackEndExclusiveUtc", "evidenceRef", "source"];
  const lines = [headers.join(",")];
  for (const item of cohort) lines.push([
    item.cohortId, item.matchedCaseId, item.address, item.target,
    new Date(item.indexAtMs).toISOString(), new Date(item.indexAtMs).toISOString(),
    item.evidenceRef, item.source,
  ].map(csvValue).join(","));
  await fsp.writeFile(path.join(outputDir, "onchain-cohort.csv"), lines.join("\n") + "\n");
  const byMonth = cohort.reduce((result, item) => {
    const key = month(item.indexAtMs);
    result[key] ||= {positives: 0, controls: 0};
    if (item.target === 1) result[key].positives += 1; else result[key].controls += 1;
    return result;
  }, {});
  const plan = {
    version: "tronsentinel-onchain-cohort-1.0.0", seed: options.seed,
    fromUtc: new Date(fromMs).toISOString(), toUtc: new Date(toMs).toISOString(),
    positivePool: positivePool.length, positives: positives.length,
    controls: cohort.length - positives.length, controlRatio: options.controlRatio,
    total: cohort.length, byMonth,
  };
  await fsp.writeFile(path.join(outputDir, "onchain-cohort-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ok: true, outputDir, ...plan}, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
}
