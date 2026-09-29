#!/usr/bin/env node

import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const DEFAULT_SAMPLE_COUNTS = { CRITICAL: 500, HIGH: 400, MEDIUM: 400, LOW: 200 };
const PROVIDERS = new Set(["tronscan", "tatum"]);
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

function usage() {
  return `
Revisión de wallets para enriquecer el dataset Risk AI

Uso:
  npm run risk:sample -- --input <wallet_legacy_pseudolabels.csv> --output <sample.csv>
  npm run risk:screen -- --input <sample.csv> --output <directorio> [opciones]
  npm run risk:blacklist-history -- --output <directorio> [opciones]
  npm run risk:blacklist-actions -- --input <tronscan-blacklist-history.csv> --output <directorio> [opciones]
  npm run risk:blacklist-resolve -- --input <tronscan-blacklist-actions.csv> --output <directorio> [opciones]

Comandos:
  sample             Genera una muestra estratificada y determinística.
  screen             Consulta TRONSCAN Security y/o Tatum. Es reanudable.
  blacklist-history  Descarga el historial de blacklist de stablecoins de TRONSCAN.
  blacklist-actions  Cruza el historial con key events y resuelve ADD/REMOVE por hash.
  blacklist-resolve  Resuelve pendientes consultando eventos exactos por transacción.

Opciones sample:
  --critical <n>      Default: 500
  --high <n>          Default: 400
  --medium <n>        Default: 400
  --low <n>           Default: 200
  --seed <texto>      Default: walletalert-risk-screen-v1

Opciones screen:
  --providers <lista> Default: tronscan,tatum
  --concurrency <n>   Default: 2; máximo: 10
  --delay-ms <n>      Espera por worker. Default: 500
  --max-retries <n>   Default: 4
  --dry-run           Valida y crea el plan sin consumir APIs.

Opciones blacklist-history:
  --page-size <n>     Default: 100; rango TRONSCAN: 20-100
  --max-pages <n>     Límite opcional para pruebas.
  --dry-run           Valida sin consumir la API.

Opciones blacklist-actions:
  --page-size <n>     Default: 100.
  --max-pages <n>     Límite opcional para pruebas.
  --delay-ms <n>      Pausa entre páginas. Default: 500.
  --dry-run           Valida y genera el plan sin consumir la API.

Opciones blacklist-resolve:
  --delay-ms <n>      Pausa entre transacciones. Default: 500.
  --max-retries <n>   Default: 4.
  --dry-run           Genera el plan sin consumir TronGrid.

Credenciales (variables de entorno, nunca argumentos):
  APP_TRONSCAN_API_KEY o TRONSCAN_API_KEY
  APP_TATUM_API_KEY o TATUM_API_KEY

Salidas screen:
  screening-results.ndjson  Evidencia completa y reanudable por wallet/proveedor
  screening-results.csv     Vista tabular
  screening-summary.json    Conteos, errores y metadatos
  labels-for-ingestion.json Sólo positivos confirmados para /v1/admin/risk/labels

Una respuesta sin banderas se registra como NOT_FLAGGED_AT_CHECK_TIME, no como
"wallet limpia". El script no escribe Firestore ni envía claves privadas.
`;
}

function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }

function readValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requiere un valor`);
  return value;
}

function integer(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  return parsed;
}

export function parseArgs(argv) {
  const command = argv[0];
  if (!command || ["--help", "-h"].includes(command)) return { help: true };
  if (!["sample", "screen", "blacklist-history", "blacklist-actions", "blacklist-resolve"].includes(command)) throw new Error(`Comando no reconocido: ${command}`);
  const options = {
    command, input: null, output: null, help: false, dryRun: false,
    counts: { ...DEFAULT_SAMPLE_COUNTS }, seed: "walletalert-risk-screen-v1",
    providers: ["tronscan", "tatum"], concurrency: 2, delayMs: 500,
    maxRetries: 4, pageSize: 100, maxPages: null,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = readValue(argv, i++, arg);
    else if (arg === "--output") options.output = readValue(argv, i++, arg);
    else if (arg === "--seed") options.seed = readValue(argv, i++, arg);
    else if (arg === "--providers") options.providers = readValue(argv, i++, arg).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    else if (arg === "--critical") options.counts.CRITICAL = integer(readValue(argv, i++, arg), arg, 0, 1_000_000);
    else if (arg === "--high") options.counts.HIGH = integer(readValue(argv, i++, arg), arg, 0, 1_000_000);
    else if (arg === "--medium") options.counts.MEDIUM = integer(readValue(argv, i++, arg), arg, 0, 1_000_000);
    else if (arg === "--low") options.counts.LOW = integer(readValue(argv, i++, arg), arg, 0, 1_000_000);
    else if (arg === "--concurrency") options.concurrency = integer(readValue(argv, i++, arg), arg, 1, 10);
    else if (arg === "--delay-ms") options.delayMs = integer(readValue(argv, i++, arg), arg, 0, 60_000);
    else if (arg === "--max-retries") options.maxRetries = integer(readValue(argv, i++, arg), arg, 0, 10);
    else if (arg === "--page-size") options.pageSize = integer(readValue(argv, i++, arg), arg, 20, 100);
    else if (arg === "--max-pages") options.maxPages = integer(readValue(argv, i++, arg), arg, 1, 1_000_000);
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Opción no reconocida: ${arg}`);
  }
  if (!options.help && !options.output) throw new Error("--output es obligatorio");
  if (!options.help && ["sample", "screen", "blacklist-actions", "blacklist-resolve"].includes(command) && !options.input) throw new Error("--input es obligatorio");
  if (!options.providers.length || options.providers.some((x) => !PROVIDERS.has(x))) throw new Error("--providers sólo admite tronscan,tatum");
  return options;
}

export function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(value); value = ""; }
    else value += char;
  }
  cells.push(value);
  return cells;
}

function csvEscape(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function readCsv(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  const rows = [];
  for await (const line of lines) {
    if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])));
  }
  return rows;
}

function deterministicRank(row, seed) { return sha256(`${seed}:${row.address.toLowerCase()}`); }

function proportionalAllocation(groups, requested) {
  const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0);
  const result = new Map();
  let allocated = 0;
  const remainders = [];
  for (const [key, rows] of groups) {
    const exact = total ? requested * rows.length / total : 0;
    const base = Math.min(rows.length, Math.floor(exact));
    result.set(key, base); allocated += base;
    remainders.push({ key, remainder: exact - base, capacity: rows.length - base });
  }
  remainders.sort((a, b) => b.remainder - a.remainder || String(a.key).localeCompare(String(b.key)));
  while (allocated < requested && remainders.some((item) => item.capacity > 0)) {
    for (const item of remainders) {
      if (allocated >= requested) break;
      if (item.capacity > 0) { result.set(item.key, result.get(item.key) + 1); item.capacity -= 1; allocated += 1; }
    }
  }
  return result;
}

export function selectStratifiedSample(rows, counts, seed = "walletalert-risk-screen-v1") {
  const valid = rows.map((row) => ({
    ...row, address: String(row.address || "").trim(),
    level: String(row.legacy_pseudo_risk_level || row.risk_level || "").trim().toUpperCase(),
    score: Number(row.legacy_pseudo_risk_score_max ?? row.risk_score ?? 0),
  })).filter((row) => TRON_ADDRESS.test(row.address) && LEVELS.includes(row.level));
  const selected = [];
  for (const level of LEVELS) {
    const levelRows = valid.filter((row) => row.level === level);
    const requested = Math.min(Number(counts[level] || 0), levelRows.length);
    const scoreGroups = new Map();
    for (const row of levelRows) {
      const key = String(row.score);
      if (!scoreGroups.has(key)) scoreGroups.set(key, []);
      scoreGroups.get(key).push(row);
    }
    const allocations = proportionalAllocation(scoreGroups, requested);
    for (const [score, group] of scoreGroups) {
      group.sort((a, b) => deterministicRank(a, seed).localeCompare(deterministicRank(b, seed)));
      selected.push(...group.slice(0, allocations.get(score) || 0));
    }
  }
  return selected.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || b.score - a.score || a.address.localeCompare(b.address));
}

async function writeCsv(filePath, headers, rows, exclusive = true) {
  const stream = createWriteStream(filePath, { encoding: "utf8", flags: exclusive ? "wx" : "w" });
  stream.write(`${headers.join(",")}\n`);
  for (const row of rows) stream.write(`${headers.map((header) => csvEscape(row[header])).join(",")}\n`);
  stream.end();
  await once(stream, "finish");
}

async function runSample(options) {
  const rows = await readCsv(path.resolve(options.input));
  const selected = selectStratifiedSample(rows, options.counts, options.seed);
  const output = path.resolve(options.output);
  await mkdir(path.dirname(output), { recursive: true });
  const headers = ["address", "chain", "legacy_risk_level", "legacy_risk_score", "sample_seed", "sampled_at_utc"];
  const sampledAt = new Date().toISOString();
  await writeCsv(output, headers, selected.map((row) => ({
    address: row.address, chain: "tron-mainnet", legacy_risk_level: row.level,
    legacy_risk_score: row.score, sample_seed: options.seed, sampled_at_utc: sampledAt,
  })));
  const byLevel = Object.fromEntries(LEVELS.map((level) => [level, selected.filter((row) => row.level === level).length]));
  console.log(JSON.stringify({ ok: true, output, selected: selected.length, byLevel }, null, 2));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function requestJson(url, init, maxRetries) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { unparsed: text.slice(0, 2000) }; }
      if (response.ok) return { httpStatus: response.status, body };
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (2 ** attempt));
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      await sleep(500 * (2 ** attempt));
    }
  }
  throw lastError || new Error("Solicitud fallida");
}

export function normalizeProviderResult(provider, body) {
  if (provider === "tatum") {
    const status = String(body?.status || "").toLowerCase();
    const invalid = status === "invalid";
    return {
      providerStatus: invalid ? "FLAGGED" : status === "valid" ? "NOT_FLAGGED_AT_CHECK_TIME" : "UNKNOWN",
      flags: { maliciousReported: invalid }, source: body?.source || null, description: body?.description || null,
    };
  }
  const isBlackList = body?.is_black_list === true;
  const hasFraud = body?.has_fraud_transaction === true;
  const fraudCreator = body?.fraud_token_creator === true;
  const spam = body?.send_ad_by_memo === true;
  return {
    providerStatus: isBlackList || hasFraud || fraudCreator || spam ? "FLAGGED" : "NOT_FLAGGED_AT_CHECK_TIME",
    flags: { isBlackList, hasFraudTransaction: hasFraud, fraudTokenCreator: fraudCreator, memoSpam: spam },
    source: "TRONSCAN", description: null,
  };
}

async function checkProvider(provider, address, keys, maxRetries) {
  const checkedAtUtc = new Date().toISOString();
  const url = provider === "tatum"
    ? `https://api.tatum.io/v3/security/address/${encodeURIComponent(address)}`
    : `https://apilist.tronscanapi.com/api/security/account/data?address=${encodeURIComponent(address)}`;
  const headers = provider === "tatum"
    ? { accept: "application/json", "x-api-key": keys.tatum }
    : { accept: "application/json", "TRON-PRO-API-KEY": keys.tronscan };
  try {
    const { httpStatus, body } = await requestJson(url, { headers }, maxRetries);
    return { address, chain: "tron-mainnet", provider, checkedAtUtc, ok: true, httpStatus, ...normalizeProviderResult(provider, body), rawResponseSha256: sha256(JSON.stringify(body)), rawResponse: body };
  } catch (error) {
    return { address, chain: "tron-mainnet", provider, checkedAtUtc, ok: false, providerStatus: "ERROR", flags: {}, source: null, description: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadExisting(filePath) {
  const results = [];
  try {
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) if (line.trim()) results.push(JSON.parse(line));
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return results;
}

async function runWorkers(tasks, concurrency, worker) {
  let next = 0;
  async function run() { while (next < tasks.length) await worker(tasks[next++]); }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, run));
}

export function consolidateResults(sampleRows, results) {
  const byAddress = new Map(sampleRows.map((row) => [row.address, { sample: row, results: [] }]));
  for (const result of results) if (byAddress.has(result.address)) byAddress.get(result.address).results.push(result);
  const rows = [];
  const labels = [];
  for (const { sample, results: providerResults } of byAddress.values()) {
    const successful = providerResults.filter((item) => item.ok);
    const tron = successful.find((item) => item.provider === "tronscan");
    const tatum = successful.find((item) => item.provider === "tatum");
    const blacklist = tron?.flags?.isBlackList === true;
    const malicious = tatum?.flags?.maliciousReported === true;
    const suspicious = tron?.flags?.hasFraudTransaction === true || tron?.flags?.fraudTokenCreator === true || tron?.flags?.memoSpam === true;
    let consolidatedStatus = "UNKNOWN";
    if (blacklist) consolidatedStatus = "BLACKLIST_CONFIRMED";
    else if (malicious) consolidatedStatus = "MALICIOUS_CONFIRMED";
    else if (suspicious) consolidatedStatus = "SUSPICIOUS";
    else if (successful.length && successful.length === providerResults.length) consolidatedStatus = "NOT_FLAGGED_AT_CHECK_TIME";
    else if (successful.length) consolidatedStatus = "PARTIAL_NOT_FLAGGED";
    const observedAt = providerResults.map((item) => item.checkedAtUtc).filter(Boolean).sort().at(-1) || null;
    rows.push({
      address: sample.address, legacy_risk_level: sample.legacy_risk_level || sample.level || "",
      legacy_risk_score: sample.legacy_risk_score || sample.score || "", consolidated_status: consolidatedStatus,
      tronscan_status: tron?.providerStatus || "NOT_CHECKED", tatum_status: tatum?.providerStatus || "NOT_CHECKED",
      is_stablecoin_blacklisted: blacklist, is_malicious_reported: malicious, has_fraud_signal: suspicious, checked_at_utc: observedAt,
    });
    if (blacklist || malicious) {
      const evidence = blacklist ? tron : tatum;
      labels.push({
        address: sample.address, source: blacklist ? "TRONSCAN_SECURITY" : `TATUM:${evidence?.source || "MALICIOUS_ADDRESS"}`,
        category: blacklist ? "BLACKLIST" : "MALICIOUS", publishedAt: evidence.checkedAtUtc,
        effectiveAt: evidence.checkedAtUtc, labelConfidence: blacklist ? 0.99 : 0.9,
        evidenceRef: `${evidence.provider}:${evidence.rawResponseSha256}`,
      });
    }
  }
  return { rows, labels };
}

async function runScreen(options) {
  const sampleRows = await readCsv(path.resolve(options.input));
  for (const row of sampleRows) if (!TRON_ADDRESS.test(String(row.address || ""))) throw new Error(`Dirección TRON inválida en muestra: ${row.address}`);
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const plan = { wallets: sampleRows.length, providers: options.providers, requests: sampleRows.length * options.providers.length };
  if (options.dryRun) {
    await writeFile(path.join(output, "screening-plan.json"), JSON.stringify({ ...plan, dryRun: true, createdAtUtc: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2));
    return;
  }
  const keys = { tronscan: process.env.APP_TRONSCAN_API_KEY || process.env.TRONSCAN_API_KEY || "", tatum: process.env.APP_TATUM_API_KEY || process.env.TATUM_API_KEY || "" };
  for (const provider of options.providers) if (!keys[provider]) throw new Error(`Falta la variable de entorno para ${provider.toUpperCase()}`);
  const ndjsonPath = path.join(output, "screening-results.ndjson");
  const existing = await loadExisting(ndjsonPath);
  const completed = new Set(existing.filter((item) => item.ok).map((item) => `${item.address}|${item.provider}`));
  const tasks = [];
  for (const row of sampleRows) for (const provider of options.providers) if (!completed.has(`${row.address}|${provider}`)) tasks.push({ address: row.address, provider });
  const newResults = [];
  await runWorkers(tasks, options.concurrency, async (task) => {
    const result = await checkProvider(task.provider, task.address, keys, options.maxRetries);
    await appendFile(ndjsonPath, `${JSON.stringify(result)}\n`, "utf8");
    newResults.push(result);
    console.log(`${existing.length + newResults.length}/${existing.length + tasks.length} ${task.provider} ${task.address} ${result.providerStatus}`);
    if (options.delayMs) await sleep(options.delayMs);
  });
  const latest = new Map();
  for (const result of [...existing, ...newResults]) latest.set(`${result.address}|${result.provider}`, result);
  const { rows, labels } = consolidateResults(sampleRows, [...latest.values()]);
  const csvHeaders = ["address", "legacy_risk_level", "legacy_risk_score", "consolidated_status", "tronscan_status", "tatum_status", "is_stablecoin_blacklisted", "is_malicious_reported", "has_fraud_signal", "checked_at_utc"];
  await writeCsv(path.join(output, "screening-results.csv"), csvHeaders, rows, false);
  await writeFile(path.join(output, "labels-for-ingestion.json"), JSON.stringify({ labels }, null, 2));
  const statusCounts = {};
  for (const row of rows) statusCounts[row.consolidated_status] = (statusCounts[row.consolidated_status] || 0) + 1;
  const summary = {
    ...plan, completedProviderChecks: [...latest.values()].filter((item) => item.ok).length,
    failedProviderChecks: [...latest.values()].filter((item) => !item.ok).length,
    positiveLabels: labels.length, statusCounts, generatedAtUtc: new Date().toISOString(),
    note: "NOT_FLAGGED_AT_CHECK_TIME no significa wallet limpia de forma permanente.",
  };
  await writeFile(path.join(output, "screening-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: true, output, ...summary }, null, 2));
}

async function runBlacklistHistory(options) {
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  if (options.dryRun) {
    await writeFile(path.join(output, "blacklist-history-plan.json"), JSON.stringify({ provider: "TRONSCAN", pageSize: options.pageSize, dryRun: true }, null, 2));
    console.log(JSON.stringify({ ok: true, dryRun: true, provider: "TRONSCAN" }, null, 2));
    return;
  }
  const key = process.env.APP_TRONSCAN_API_KEY || process.env.TRONSCAN_API_KEY || "";
  if (!key) throw new Error("Falta APP_TRONSCAN_API_KEY o TRONSCAN_API_KEY");
  const records = [];
  let total = null;
  for (let page = 0; total == null || records.length < total; page += 1) {
    if (options.maxPages != null && page >= options.maxPages) break;
    const start = page * options.pageSize;
    const url = `https://apilist.tronscanapi.com/api/stableCoin/blackList?sort=2&direction=1&start=${start}&limit=${options.pageSize}`;
    const response = await requestJson(url, { headers: { accept: "application/json", "TRON-PRO-API-KEY": key } }, options.maxRetries);
    total = Number(response.body?.total || 0);
    const pageRows = Array.isArray(response.body?.data) ? response.body.data : [];
    records.push(...pageRows);
    if (!pageRows.length) break;
    if (options.delayMs) await sleep(options.delayMs);
  }
  const unique = new Map();
  for (const row of records) unique.set(`${row.blackAddress}|${row.transHash}|${row.time}`, row);
  const rows = [...unique.values()].map((row) => ({
    address: row.blackAddress, token_name: row.tokenName, amount_frozen_raw: row.num,
    event_at_utc: Number.isFinite(Number(row.time)) ? new Date(Number(row.time) * 1000).toISOString() : "",
    transaction_hash: row.transHash, contract_address: row.contractAddress,
    event_action: "REQUIRES_TRANSACTION_ENRICHMENT",
  }));
  await writeCsv(path.join(output, "tronscan-blacklist-history.csv"), ["address", "token_name", "amount_frozen_raw", "event_at_utc", "transaction_hash", "contract_address", "event_action"], rows, false);
  await writeFile(path.join(output, "tronscan-blacklist-history.ndjson"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(path.join(output, "blacklist-history-summary.json"), JSON.stringify({ provider: "TRONSCAN", reportedTotal: total, downloaded: records.length, unique: rows.length, generatedAtUtc: new Date().toISOString(), warning: "El endpoint contiene altas y bajas; event_action debe enriquecerse con la transacción antes de crear labels." }, null, 2));
  console.log(JSON.stringify({ ok: true, output, reportedTotal: total, unique: rows.length }, null, 2));
}

export function classifyBlacklistEventName(eventName) {
  const normalized = String(eventName || "").replaceAll(/[^a-z]/gi, "").toLowerCase();
  if (normalized === "addedblacklist" || normalized === "addblacklist") return "ADD";
  if (normalized === "removedblacklist" || normalized === "removeblacklist") return "REMOVE";
  return "UNKNOWN";
}

export function buildMonthlyWindows(minimumMs, maximumMs) {
  const windows = [];
  let cursor = Date.UTC(new Date(minimumMs).getUTCFullYear(), new Date(minimumMs).getUTCMonth(), 1);
  const finalMonth = Date.UTC(new Date(maximumMs).getUTCFullYear(), new Date(maximumMs).getUTCMonth(), 1);
  while (cursor <= finalMonth) {
    const date = new Date(cursor);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    windows.push({
      key: new Date(cursor).toISOString().slice(0, 7),
      startSeconds: Math.floor(cursor / 1000),
      endSeconds: Math.floor((next - 1000) / 1000),
    });
    cursor = next;
  }
  return windows;
}

function base58Encode(buffer) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${buffer.toString("hex")}`);
  let result = "";
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || "1";
}

export function tronHexToBase58(value) {
  const normalized = String(value || "").replace(/^0x/i, "").toLowerCase();
  const payloadHex = normalized.length === 40 ? `41${normalized}` : normalized;
  if (!/^41[0-9a-f]{40}$/.test(payloadHex)) throw new Error("INVALID_TRON_HEX_ADDRESS");
  const payload = Buffer.from(payloadHex, "hex");
  const first = createHash("sha256").update(payload).digest();
  const checksum = createHash("sha256").update(first).digest().subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

export function classifyTransactionEvents(events, expectedAddress, expectedContract) {
  const candidates = (Array.isArray(events) ? events : []).filter((event) =>
    String(event.transaction_id || "").length === 64 &&
    String(event.contract_address || "") === expectedContract &&
    ["AddedBlackList", "RemovedBlackList", "Blacklisted"].includes(String(event.event_name || "")),
  );
  for (const event of candidates) {
    const targetValue = event.result?._user || event.result?.user || event.result?.account || event.result?.["0"];
    let targetAddress;
    try { targetAddress = tronHexToBase58(targetValue); } catch { continue; }
    if (targetAddress !== expectedAddress) continue;
    let action;
    if (event.event_name === "AddedBlackList") action = "ADD";
    else if (event.event_name === "RemovedBlackList") action = "REMOVE";
    else {
      const rawFlag = event.result?.isBlacklisted ?? event.result?.["1"];
      if ([true, 1, "true", "1"].includes(rawFlag)) action = "ADD";
      else if ([false, 0, "false", "0"].includes(rawFlag)) action = "REMOVE";
      else continue;
    }
    return {
      action,
      eventName: event.event_name,
      targetAddress,
      contractAddress: event.contract_address,
      transactionId: event.transaction_id,
    };
  }
  return null;
}

async function runBlacklistActions(options) {
  const sourcePath = path.resolve(options.input);
  const sourceRows = await readCsv(sourcePath);
  if (!sourceRows.length) throw new Error("El historial de blacklist está vacío");
  for (const row of sourceRows) {
    if (!TRON_ADDRESS.test(String(row.address || ""))) throw new Error(`Dirección TRON inválida: ${row.address}`);
    if (!/^[0-9a-f]{64}$/i.test(String(row.transaction_hash || ""))) throw new Error(`Hash inválido: ${row.transaction_hash}`);
  }
  const sourceTimes = sourceRows.map((row) => Date.parse(row.event_at_utc)).filter(Number.isFinite);
  if (sourceTimes.length !== sourceRows.length) throw new Error("El historial contiene fechas inválidas");
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const range = {startTime: Math.min(...sourceTimes), endTime: Math.max(...sourceTimes)};
  const windows = buildMonthlyWindows(range.startTime, range.endTime);
  if (options.dryRun) {
    const plan = {provider: "TRONSCAN_KEY_EVENTS", sourceRows: sourceRows.length, ...range, monthlyWindows: windows.length, dryRun: true};
    await writeFile(path.join(output, "blacklist-actions-plan.json"), JSON.stringify(plan, null, 2));
    console.log(JSON.stringify({ ok: true, output, ...plan }, null, 2));
    return;
  }
  const key = process.env.APP_TRONSCAN_API_KEY || process.env.TRONSCAN_API_KEY || "";
  if (!key) throw new Error("Falta APP_TRONSCAN_API_KEY o TRONSCAN_API_KEY");
  const rawEventsPath = path.join(output, "tronscan-blacklist-key-events.ndjson");
  const checkpointPath = path.join(output, "blacklist-actions-checkpoint.json");
  const sourceFingerprint = sha256(sourceRows.map((row) => row.transaction_hash).join("\n"));
  let checkpoint = {sourceFingerprint, pageSize: options.pageSize, nextWindowIndex: 0};
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    if (checkpoint.sourceFingerprint !== sourceFingerprint || checkpoint.pageSize !== options.pageSize) {
      throw new Error("CHECKPOINT_DOES_NOT_MATCH_SOURCE_OR_PAGE_SIZE");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const keyEvents = await loadExisting(rawEventsPath);
  let pagesDownloadedThisRun = 0;
  let stoppedByMaxPages = false;
  let nextWindowIndex = checkpoint.nextWindowIndex;
  for (let windowIndex = checkpoint.nextWindowIndex; windowIndex < windows.length; windowIndex += 1) {
    const window = windows[windowIndex];
    let total = null;
    let completedWindow = true;
    for (let page = 0; total == null || page * options.pageSize < total; page += 1) {
      if (options.maxPages != null && pagesDownloadedThisRun >= options.maxPages) {
        stoppedByMaxPages = true;
        completedWindow = false;
        break;
      }
      const params = new URLSearchParams({
        start: String(page * options.pageSize),
        limit: String(options.pageSize),
        sort: "1",
        direction: "2",
        startTime: String(window.startSeconds),
        endTime: String(window.endSeconds),
      });
      const url = `https://apilist.tronscanapi.com/api/deep/stableCoin/totalSupply/keyEvents?${params}`;
      const response = await requestJson(url, {headers: {accept: "application/json", "TRON-PRO-API-KEY": key}}, options.maxRetries);
      if (Number(response.body?.code) !== 0) {
        throw new Error(`TRONSCAN_KEY_EVENTS_CODE:${response.body?.code}:${response.body?.msg || "UNKNOWN"}`);
      }
      total = Number(response.body?.total || 0);
      if (total > 10_000) throw new Error(`MONTH_EXCEEDS_PAGINATION_LIMIT:${window.key}:${total}`);
      const pageRows = Array.isArray(response.body?.data) ? response.body.data : [];
      keyEvents.push(...pageRows);
      if (pageRows.length) await appendFile(rawEventsPath, `${pageRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
      pagesDownloadedThisRun += 1;
      console.log(`${window.key} ${Math.min((page + 1) * options.pageSize, total)}/${total} key events`);
      if (!pageRows.length) break;
      if (options.delayMs) await sleep(options.delayMs);
    }
    if (!completedWindow) break;
    nextWindowIndex = windowIndex + 1;
    checkpoint = {sourceFingerprint, pageSize: options.pageSize, nextWindowIndex, completedThrough: window.key};
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
  }
  const uniqueKeyEvents = [...new Map(keyEvents.map((event) => [
    `${String(event.hash || "").toLowerCase()}|${event.eventName}|${event.time}`,
    event,
  ])).values()];
  await writeFile(rawEventsPath, uniqueKeyEvents.length ? `${uniqueKeyEvents.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
  const byHash = new Map();
  for (const event of uniqueKeyEvents) {
    const action = classifyBlacklistEventName(event.eventName);
    if (action !== "UNKNOWN") byHash.set(String(event.hash || "").toLowerCase(), { ...event, action });
  }
  const observedAtUtc = new Date().toISOString();
  const enriched = sourceRows.map((row) => {
    const matched = byHash.get(String(row.transaction_hash).toLowerCase());
    return {
      ...row,
      event_action: matched?.action || "UNMATCHED",
      key_event_name: matched?.eventName || "",
      key_event_time_utc: Number.isFinite(Number(matched?.time)) ? new Date(Number(matched.time)).toISOString() : "",
      key_event_operator: matched?.operatorAddress || "",
    };
  });
  const headers = [
    "address", "token_name", "amount_frozen_raw", "event_at_utc", "transaction_hash",
    "contract_address", "event_action", "key_event_name", "key_event_time_utc", "key_event_operator",
  ];
  await writeCsv(path.join(output, "tronscan-blacklist-actions.csv"), headers, enriched, false);
  const labels = enriched.filter((row) => row.event_action === "ADD").map((row) => ({
    address: row.address,
    chain: "tron-mainnet",
    category: "BLACKLIST",
    action: "ADD",
    dateBasis: "ONCHAIN_EVENT",
    effectiveAtUtc: row.event_at_utc,
    observedAtUtc,
    source: "TRONSCAN_STABLECOIN_KEY_EVENTS",
    evidenceRef: `tx:${row.transaction_hash}`,
    confidence: 1,
  }));
  await writeCsv(
    path.join(output, "blacklist-label-events.csv"),
    ["address", "chain", "category", "action", "dateBasis", "effectiveAtUtc", "observedAtUtc", "source", "evidenceRef", "confidence"],
    labels,
    false,
  );
  const actionCounts = enriched.reduce((counts, row) => {
    counts[row.event_action] = (counts[row.event_action] || 0) + 1;
    return counts;
  }, {});
  const summary = {
    provider: "TRONSCAN_KEY_EVENTS",
    sourceRows: sourceRows.length,
    monthlyWindows: windows.length,
    completedWindows: nextWindowIndex,
    pagesDownloadedThisRun,
    stoppedByMaxPages,
    downloadedKeyEvents: uniqueKeyEvents.length,
    matchedBlacklistEvents: enriched.length - Number(actionCounts.UNMATCHED || 0),
    actionCounts,
    positiveLabels: labels.length,
    generatedAtUtc: observedAtUtc,
    trainingSafe: nextWindowIndex === windows.length && Number(actionCounts.UNMATCHED || 0) === 0,
  };
  await writeFile(path.join(output, "blacklist-actions-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: true, output, ...summary }, null, 2));
}

async function runBlacklistResolve(options) {
  const inputPath = path.resolve(options.input);
  const sourceRows = await readCsv(inputPath);
  if (!sourceRows.length) throw new Error("El archivo de acciones está vacío");
  const pending = sourceRows.filter((row) => row.event_action === "UNMATCHED");
  const output = path.resolve(options.output);
  await mkdir(output, {recursive: true});
  if (options.dryRun) {
    const plan = {provider: "TRONGRID_TRANSACTION_EVENTS", sourceRows: sourceRows.length, pending: pending.length, dryRun: true};
    await writeFile(path.join(output, "blacklist-resolve-plan.json"), JSON.stringify(plan, null, 2));
    console.log(JSON.stringify({ok: true, output, ...plan}, null, 2));
    return;
  }
  const evidencePath = path.join(output, "trongrid-transaction-event-evidence.ndjson");
  const existing = await loadExisting(evidencePath);
  const completed = new Set(existing
    .filter((item) => item.ok && ["ADD", "REMOVE"].includes(item.action))
    .map((item) => item.transactionHash));
  const newEvidence = [];
  for (let index = 0; index < pending.length; index += 1) {
    const row = pending[index];
    if (completed.has(row.transaction_hash)) continue;
    const url = `https://api.trongrid.io/v1/transactions/${encodeURIComponent(row.transaction_hash)}/events?only_confirmed=true`;
    try {
      const response = await requestJson(url, {headers: {accept: "application/json"}}, options.maxRetries);
      const events = Array.isArray(response.body?.data) ? response.body.data : [];
      const classification = classifyTransactionEvents(events, row.address, row.contract_address);
      const evidence = {
        transactionHash: row.transaction_hash,
        address: row.address,
        contractAddress: row.contract_address,
        ok: true,
        action: classification?.action || "UNRESOLVED",
        eventName: classification?.eventName || null,
        eventCount: events.length,
        responseAtUtc: new Date().toISOString(),
        responseSha256: sha256(JSON.stringify(response.body)),
      };
      await appendFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
      newEvidence.push(evidence);
      console.log(`${existing.length + newEvidence.length}/${pending.length} ${row.transaction_hash} ${evidence.action}`);
    } catch (error) {
      const evidence = {
        transactionHash: row.transaction_hash,
        address: row.address,
        contractAddress: row.contract_address,
        ok: false,
        action: "ERROR",
        error: error instanceof Error ? error.message : String(error),
        responseAtUtc: new Date().toISOString(),
      };
      await appendFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
      newEvidence.push(evidence);
      console.log(`${existing.length + newEvidence.length}/${pending.length} ${row.transaction_hash} ERROR`);
    }
    if (options.delayMs) await sleep(options.delayMs);
  }
  const latest = new Map();
  for (const item of [...existing, ...newEvidence]) latest.set(item.transactionHash, item);
  const observedAtUtc = new Date().toISOString();
  const finalRows = sourceRows.map((row) => {
    if (row.event_action !== "UNMATCHED") return {...row, resolution_source: "TRONSCAN_KEY_EVENTS_CATALOG"};
    const evidence = latest.get(row.transaction_hash);
    return {
      ...row,
      event_action: evidence?.ok && ["ADD", "REMOVE"].includes(evidence.action) ? evidence.action : "UNRESOLVED",
      key_event_name: evidence?.eventName || row.key_event_name || "",
      resolution_source: evidence?.ok ? "TRONGRID_TRANSACTION_EVENTS" : "TRONGRID_ERROR",
    };
  });
  const headers = [
    "address", "token_name", "amount_frozen_raw", "event_at_utc", "transaction_hash",
    "contract_address", "event_action", "key_event_name", "key_event_time_utc",
    "key_event_operator", "resolution_source",
  ];
  await writeCsv(path.join(output, "tronscan-blacklist-actions-final.csv"), headers, finalRows, false);
  const labels = finalRows.filter((row) => row.event_action === "ADD").map((row) => ({
    address: row.address,
    chain: "tron-mainnet",
    category: "BLACKLIST",
    action: "ADD",
    dateBasis: "ONCHAIN_EVENT",
    effectiveAtUtc: row.event_at_utc,
    observedAtUtc,
    source: row.resolution_source,
    evidenceRef: `tx:${row.transaction_hash}`,
    confidence: 1,
  }));
  await writeCsv(
    path.join(output, "blacklist-label-events-final.csv"),
    ["address", "chain", "category", "action", "dateBasis", "effectiveAtUtc", "observedAtUtc", "source", "evidenceRef", "confidence"],
    labels,
    false,
  );
  const actionCounts = finalRows.reduce((counts, row) => {
    counts[row.event_action] = (counts[row.event_action] || 0) + 1;
    return counts;
  }, {});
  const summary = {
    provider: "TRONSCAN_PLUS_TRONGRID_TRANSACTION_EVENTS",
    sourceRows: sourceRows.length,
    fallbackRequested: pending.length,
    fallbackCompleted: [...latest.values()].filter((item) => item.ok).length,
    actionCounts,
    positiveLabels: labels.length,
    generatedAtUtc: observedAtUtc,
    trainingSafe: Number(actionCounts.UNRESOLVED || 0) === 0 && Number(actionCounts.ERROR || 0) === 0,
  };
  await writeFile(path.join(output, "blacklist-resolve-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ok: true, output, ...summary}, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return; }
  if (options.command === "sample") await runSample(options);
  else if (options.command === "screen") await runScreen(options);
  else if (options.command === "blacklist-history") await runBlacklistHistory(options);
  else if (options.command === "blacklist-actions") await runBlacklistActions(options);
  else await runBlacklistResolve(options);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((error) => { console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
