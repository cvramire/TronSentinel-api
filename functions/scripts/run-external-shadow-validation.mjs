#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = {delayMs: 250, maxRetries: 4};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cohort") options.cohort = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--base-url") options.baseUrl = argv[++index];
    else if (arg === "--delay-ms") options.delayMs = Number(argv[++index]);
    else if (arg === "--max-retries") options.maxRetries = Number(argv[++index]);
    else if (arg === "--max-rows") options.maxRows = Number(argv[++index]);
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.cohort || !options.outputDir || !options.baseUrl) {
    throw new Error("COHORT_OUTPUT_DIR_BASE_URL_REQUIRED");
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

async function readNdjson(filePath) {
  const rows = [];
  try {
    const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
    for await (const line of reader) if (line.trim()) rows.push(JSON.parse(line));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return rows;
}

async function callScore(url, apiKey, row, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json", "x-api-key": apiKey},
        body: JSON.stringify({address: row.address, asOf: row.asOfUtc}),
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = {raw: text.slice(0, 500)}; }
      if (response.ok) return {ok: true, status: response.status, body};
      const exclusion = response.status === 422 &&
        ["INSUFFICIENT_HISTORY", "HISTORY_TRUNCATED"].includes(body.error);
      if (exclusion) return {ok: false, excluded: true, status: response.status, body};
      if (response.status !== 429 && response.status < 500) {
        return {ok: false, excluded: false, status: response.status, body};
      }
      lastError = new Error(`HTTP_${response.status}:${body.error || "UNKNOWN"}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < retries) await sleep(1000 * (2 ** attempt));
  }
  return {ok: false, excluded: false, status: 0, body: {error: String(lastError?.message || lastError)}};
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = String(process.env.TRONSENTINEL_API_KEY || "").trim();
  if (!options.dryRun && !apiKey) throw new Error("Falta TRONSENTINEL_API_KEY");
  let cohort = await readCsv(path.resolve(options.cohort));
  if (Number.isInteger(options.maxRows) && options.maxRows > 0) cohort = cohort.slice(0, options.maxRows);
  const outputDir = path.resolve(options.outputDir);
  await fsp.mkdir(outputDir, {recursive: true});
  const resultsPath = path.join(outputDir, "external-shadow-results.ndjson");
  const existing = await readNdjson(resultsPath);
  const latest = new Map(existing.map((item) => [item.externalId, item]));
  const completed = new Set([...latest.values()]
    .filter((item) => item.ok || item.excluded)
    .map((item) => item.externalId));
  const plan = {
    cohort: path.resolve(options.cohort),
    rows: cohort.length,
    alreadyTerminal: completed.size,
    endpoint: `${String(options.baseUrl).replace(/\/$/, "")}/v1/score/wallet/shadow/live`,
    delayMs: options.delayMs,
  };
  await fsp.writeFile(path.join(outputDir, "external-shadow-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ok: true, dryRun: true, ...plan}, null, 2)}\n`);
    return;
  }
  let position = 0;
  for (const row of cohort) {
    position += 1;
    if (completed.has(row.externalId)) continue;
    const result = await callScore(plan.endpoint, apiKey, row, options.maxRetries);
    const record = {
      externalId: row.externalId,
      matchedCaseId: row.matchedCaseId,
      address: row.address,
      target: Number(row.target),
      asOfUtc: row.asOfUtc,
      labelEffectiveAtUtc: row.labelEffectiveAtUtc || null,
      ok: result.ok,
      excluded: Boolean(result.excluded),
      httpStatus: result.status,
      error: result.ok ? null : result.body?.error || "REQUEST_FAILED",
      response: result.ok ? result.body : null,
      completedAtUtc: new Date().toISOString(),
    };
    await fsp.appendFile(resultsPath, `${JSON.stringify(record)}\n`);
    latest.set(row.externalId, record);
    const outcome = result.ok ?
      `${result.body.riskLevel} score=${result.body.riskScore} review=${result.body.reviewRecommended}` :
      `${record.excluded ? "EXCLUDED" : "ERROR"} ${record.error}`;
    process.stdout.write(`${position}/${cohort.length} target=${row.target} ${row.address} ${outcome}\n`);
    if (options.delayMs) await sleep(options.delayMs);
  }
  const records = cohort.map((row) => latest.get(row.externalId)).filter(Boolean);
  const scored = records.filter((row) => row.ok);
  const summary = {
    ok: true,
    rows: cohort.length,
    scored: scored.length,
    positivesScored: scored.filter((row) => row.target === 1).length,
    controlsScored: scored.filter((row) => row.target === 0).length,
    excluded: records.filter((row) => row.excluded).length,
    errors: records.filter((row) => !row.ok && !row.excluded).length,
    falseNegatives: scored.filter((row) => row.target === 1 && !row.response.reviewRecommended).length,
    falsePositives: scored.filter((row) => row.target === 0 && row.response.reviewRecommended).length,
    complete: records.length === cohort.length && records.every((row) => row.ok || row.excluded),
    generatedAtUtc: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(outputDir, "external-shadow-run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
