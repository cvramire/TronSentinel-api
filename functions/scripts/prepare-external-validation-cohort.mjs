#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const options = {
    positives: 200,
    controlsPerPositive: 3,
    followupDays: 90,
    positiveFrom: "2026-01-01T00:00:00.000Z",
    positiveTo: "2026-06-09T23:59:59.999Z",
    seed: "tronsentinel-external-v1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--labels") options.labels = argv[++index];
    else if (arg === "--training-cohort") options.trainingCohort = argv[++index];
    else if (arg === "--control-source") options.controlSource = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--positives") options.positives = Number(argv[++index]);
    else if (arg === "--controls-per-positive") options.controlsPerPositive = Number(argv[++index]);
    else if (arg === "--followup-days") options.followupDays = Number(argv[++index]);
    else if (arg === "--positive-from") options.positiveFrom = argv[++index];
    else if (arg === "--positive-to") options.positiveTo = argv[++index];
    else if (arg === "--seed") options.seed = argv[++index];
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.labels || !options.trainingCohort || !options.controlSource || !options.output) {
    throw new Error("LABELS_TRAINING_CONTROL_SOURCE_OUTPUT_REQUIRED");
  }
  return options;
}

async function readCsv(filePath) {
  const rows = [];
  const reader = readline.createInterface({
    input: fs.createReadStream(path.resolve(filePath)),
    crlfDelay: Infinity,
  });
  let headers;
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

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function stableHash(value, seed) {
  return crypto.createHash("sha256").update(`${seed}|${value}`).digest("hex");
}

function isoDate(value) {
  const parsed = Date.parse(String(value || "").replace(" ", "T"));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function validAddress(value) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(value || ""));
}

function evenlySelect(rows, count) {
  if (rows.length < count) throw new Error(`NOT_ENOUGH_POSITIVES:${rows.length}<${count}`);
  if (count === 1) return [rows[Math.floor(rows.length / 2)]];
  return Array.from({length: count}, (_, index) =>
    rows[Math.floor(index * (rows.length - 1) / (count - 1))]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [labels, training, controlSource] = await Promise.all([
    readCsv(options.labels),
    readCsv(options.trainingCohort),
    readCsv(options.controlSource),
  ]);
  const trainingAddresses = new Set(training.map((row) => row.address));
  const blacklistAddresses = new Set(labels.map((row) => row.address));
  const latestLabelMs = Math.max(...labels.map((row) => Date.parse(row.effectiveAtUtc) || 0));
  const positiveFromMs = Date.parse(options.positiveFrom);
  const positiveToMs = Date.parse(options.positiveTo);
  const positiveCandidates = labels
    .filter((row) => row.action === "ADD" && row.confidence === "1")
    .filter((row) => validAddress(row.address) && !trainingAddresses.has(row.address))
    .map((row) => ({...row, asOfMs: Date.parse(row.effectiveAtUtc) - 1}))
    .filter((row) => row.asOfMs >= positiveFromMs && row.asOfMs <= positiveToMs)
    .sort((a, b) => a.asOfMs - b.asOfMs ||
      stableHash(a.address, options.seed).localeCompare(stableHash(b.address, options.seed)));
  const positives = evenlySelect(positiveCandidates, options.positives);
  const controls = controlSource
    .filter((row) => validAddress(row.address))
    .filter((row) => !trainingAddresses.has(row.address) && !blacklistAddresses.has(row.address))
    .map((row) => ({
      ...row,
      asOfUtc: isoDate(row.last_event_utc),
      asOfMs: Date.parse(isoDate(row.last_event_utc)),
      eventCount: Number(row.event_count || 0),
    }))
    .filter((row) => Number.isFinite(row.asOfMs) && row.eventCount > 0)
    .filter((row) => latestLabelMs - row.asOfMs >= options.followupDays * DAY_MS)
    .sort((a, b) => stableHash(a.address, options.seed).localeCompare(
      stableHash(b.address, options.seed),
    ));
  const availableControls = new Map(controls.map((row) => [row.address, row]));
  const outputRows = [];
  for (let index = 0; index < positives.length; index += 1) {
    const positive = positives[index];
    const matchedCaseId = `external_case_${stableHash(positive.address, options.seed).slice(0, 16)}`;
    outputRows.push({
      externalId: matchedCaseId,
      matchedCaseId,
      address: positive.address,
      target: 1,
      asOfUtc: new Date(positive.asOfMs).toISOString(),
      labelEffectiveAtUtc: positive.effectiveAtUtc,
      evidenceRef: positive.evidenceRef,
      source: positive.source,
      selectionRole: "CONFIRMED_BLACKLIST_OUT_OF_TRAINING",
    });
    const candidates = [...availableControls.values()]
      .sort((a, b) => Math.abs(a.asOfMs - positive.asOfMs) -
        Math.abs(b.asOfMs - positive.asOfMs) ||
        stableHash(a.address, matchedCaseId).localeCompare(stableHash(b.address, matchedCaseId)))
      .slice(0, options.controlsPerPositive);
    if (candidates.length < options.controlsPerPositive) throw new Error("NOT_ENOUGH_CONTROLS");
    for (let controlIndex = 0; controlIndex < candidates.length; controlIndex += 1) {
      const control = candidates[controlIndex];
      availableControls.delete(control.address);
      outputRows.push({
        externalId: `external_control_${stableHash(control.address, options.seed).slice(0, 16)}`,
        matchedCaseId,
        address: control.address,
        target: 0,
        asOfUtc: control.asOfUtc,
        labelEffectiveAtUtc: "",
        evidenceRef: "",
        source: "WALLET_ALERT_ACTIVE_CONTROL_WITH_90D_FOLLOWUP",
        selectionRole: `DATE_MATCHED_CONTROL_${controlIndex + 1}`,
      });
    }
  }
  const headers = [
    "externalId", "matchedCaseId", "address", "target", "asOfUtc",
    "labelEffectiveAtUtc", "evidenceRef", "source", "selectionRole",
  ];
  const lines = [headers.join(",")];
  for (const row of outputRows) lines.push(headers.map((header) => csvValue(row[header])).join(","));
  const output = path.resolve(options.output);
  await fsp.mkdir(path.dirname(output), {recursive: true});
  await fsp.writeFile(output, `${lines.join("\n")}\n`);
  const summary = {
    ok: true,
    cohortVersion: "tronsentinel-external-validation-v1",
    output,
    rows: outputRows.length,
    positives: outputRows.filter((row) => row.target === 1).length,
    controls: outputRows.filter((row) => row.target === 0).length,
    excludedFromTraining: true,
    followupDays: options.followupDays,
    positivePeriod: {from: options.positiveFrom, to: options.positiveTo},
    latestLabelAtUtc: new Date(latestLabelMs).toISOString(),
    generatedAtUtc: new Date().toISOString(),
  };
  await fsp.writeFile(`${output}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
