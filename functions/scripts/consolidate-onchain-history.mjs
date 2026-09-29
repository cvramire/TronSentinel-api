#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

const DAY_MS = 86_400_000;

function parseArgs(argv) {
  const options = {sourceDirs: [], lookbackDays: 90};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cohort") options.cohort = argv[++index];
    else if (arg === "--source-dir") options.sourceDirs.push(argv[++index]);
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--lookback-days") options.lookbackDays = Number(argv[++index]);
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.cohort || !options.outputDir || !options.sourceDirs.length) {
    throw new Error("COHORT_OUTPUT_AND_SOURCE_DIRS_REQUIRED");
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
  return {headers, rows};
}

async function readNdjson(filePath, onRow) {
  const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
  for await (const line of reader) if (line.trim()) await onRow(JSON.parse(line));
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cohort = await readCsv(path.resolve(options.cohort));
  const cohortById = new Map(cohort.rows.map((row) => [row.cohortId, row]));
  if (cohortById.size !== cohort.rows.length) throw new Error("DUPLICATE_COHORT_ID");
  const sourceDirs = options.sourceDirs.map((item) => path.resolve(item));
  const candidates = new Map();

  for (let sourceIndex = 0; sourceIndex < sourceDirs.length; sourceIndex += 1) {
    const sourceDir = sourceDirs[sourceIndex];
    const latest = new Map();
    await readNdjson(path.join(sourceDir, "onchain-wallet-status.ndjson"), async (status) => latest.set(status.cohortId, status));
    for (const status of latest.values()) {
      if (!cohortById.has(status.cohortId)) continue;
      if (!candidates.has(status.cohortId)) candidates.set(status.cohortId, []);
      candidates.get(status.cohortId).push({...status, sourceDir, sourceIndex});
    }
  }

  const selections = new Map();
  for (const row of cohort.rows) {
    const values = candidates.get(row.cohortId) || [];
    const complete = values.filter((item) => item.ok && !item.truncated).at(-1);
    const censored = values.filter((item) => item.ok).at(-1);
    selections.set(row.cohortId, complete || censored || null);
  }

  const outputDir = path.resolve(options.outputDir);
  await fsp.mkdir(outputDir, {recursive: true});
  const transferPath = path.join(outputDir, "onchain-transfers-complete.ndjson");
  await fsp.writeFile(transferPath, "");
  const output = await fsp.open(transferPath, "a");
  const eventIds = new Set();
  const finishedCohorts = new Set();
  let written = 0;
  let duplicateEvents = 0;
  let currentCohort = "";
  let buffer = [];

  async function flush() {
    if (!buffer.length) return;
    await output.write(`${buffer.join("\n")}\n`);
    buffer = [];
  }

  try {
    for (let sourceIndex = 0; sourceIndex < sourceDirs.length; sourceIndex += 1) {
      const sourceDir = sourceDirs[sourceIndex];
      await readNdjson(path.join(sourceDir, "onchain-transfers.ndjson"), async (record) => {
        const selection = selections.get(record.cohortId);
        if (!selection || selection.truncated || selection.sourceIndex !== sourceIndex) return;
        const cohortRow = cohortById.get(record.cohortId);
        if (!cohortRow || record.address !== cohortRow.address) throw new Error(`COHORT_ADDRESS_MISMATCH:${record.cohortId}`);
        const indexMs = Date.parse(cohortRow.indexAtUtc);
        const timestamp = Number(record.blockTimestamp);
        if (!(timestamp < indexMs && timestamp >= indexMs - options.lookbackDays * DAY_MS)) {
          throw new Error(`POINT_IN_TIME_VIOLATION:${record.cohortId}:${timestamp}`);
        }
        if (record.cohortId !== currentCohort) {
          await flush();
          if (currentCohort) finishedCohorts.add(currentCohort);
          if (finishedCohorts.has(record.cohortId)) throw new Error(`NON_CONTIGUOUS_COHORT:${record.cohortId}`);
          currentCohort = record.cohortId;
          eventIds.clear();
        }
        if (eventIds.has(record.eventId)) { duplicateEvents += 1; return; }
        eventIds.add(record.eventId);
        buffer.push(JSON.stringify(record));
        written += 1;
        if (buffer.length >= 5000) await flush();
      });
    }
    await flush();
  } finally {
    await output.close();
  }

  const walletHeaders = [...cohort.headers, "historyStatus", "historySource", "historyPages", "historyTransfers"];
  const walletLines = [walletHeaders.join(",")];
  const excludedLines = [walletHeaders.join(",")];
  let completeWallets = 0;
  let censoredWallets = 0;
  let missingWallets = 0;
  let positiveComplete = 0;
  let controlComplete = 0;
  for (const row of cohort.rows) {
    const selection = selections.get(row.cohortId);
    const status = selection ? (selection.truncated ? "CENSORED" : "COMPLETE") : "MISSING";
    if (status === "COMPLETE") {
      completeWallets += 1;
      if (Number(row.target) === 1) positiveComplete += 1; else controlComplete += 1;
    } else if (status === "CENSORED") censoredWallets += 1;
    else missingWallets += 1;
    const values = walletHeaders.map((header) => {
      if (header === "historyStatus") return status;
      if (header === "historySource") return selection?.sourceDir || "";
      if (header === "historyPages") return selection?.pages ?? "";
      if (header === "historyTransfers") return selection?.transfers ?? "";
      return row[header] ?? "";
    });
    const line = values.map(csvValue).join(",");
    walletLines.push(line);
    if (status !== "COMPLETE") excludedLines.push(line);
  }
  await fsp.writeFile(path.join(outputDir, "onchain-wallets-consolidated.csv"), `${walletLines.join("\n")}\n`);
  await fsp.writeFile(path.join(outputDir, "onchain-wallets-excluded.csv"), `${excludedLines.join("\n")}\n`);
  const summary = {
    cohortWallets: cohort.rows.length,
    completeWallets, positiveComplete, controlComplete, censoredWallets, missingWallets,
    includedTransfers: written, duplicateEvents,
    pointInTimeValidated: true,
    trainingReady: positiveComplete > 0 && controlComplete > 0 && missingWallets === 0,
    generatedAtUtc: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(outputDir, "onchain-consolidation-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ok: true, outputDir, ...summary}, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
