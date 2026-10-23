#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const CONTRACTS = [
  {symbol: "USDT", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"},
  {symbol: "TUSD", address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4"},
];
const BASE_URL = "https://api.trongrid.io";
const ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function parseArgs(argv) {
  const options = {
    caseLimit: 100,
    developmentPerCase: 4,
    holdoutPerCase: 2,
    windowSeconds: 300,
    pageSize: 200,
    pagesPerContract: 1,
    delayMs: 100,
    maxRetries: 6,
    seed: "tronsentinel-risk-set-v5",
    activityAnchor: "index",
    anchorMaxDays: 90,
    excludes: [],
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases") options.cases = argv[++index];
    else if (arg === "--labels") options.labels = argv[++index];
    else if (arg === "--exclude") options.excludes.push(argv[++index]);
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--case-limit") options.caseLimit = Number(argv[++index]);
    else if (arg === "--development-per-case") options.developmentPerCase = Number(argv[++index]);
    else if (arg === "--holdout-per-case") options.holdoutPerCase = Number(argv[++index]);
    else if (arg === "--window-seconds") options.windowSeconds = Number(argv[++index]);
    else if (arg === "--page-size") options.pageSize = Number(argv[++index]);
    else if (arg === "--pages-per-contract") options.pagesPerContract = Number(argv[++index]);
    else if (arg === "--delay-ms") options.delayMs = Number(argv[++index]);
    else if (arg === "--max-retries") options.maxRetries = Number(argv[++index]);
    else if (arg === "--seed") options.seed = argv[++index];
    else if (arg === "--activity-anchor") options.activityAnchor = argv[++index];
    else if (arg === "--anchor-max-days") options.anchorMaxDays = Number(argv[++index]);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  return options;
}

function usage() {
  return `Uso:
  node scripts/prepare-risk-set-controls-v5.mjs \\
    --cases <onchain-feature-dataset.csv> \\
    --labels <blacklist-label-events-final.csv> \\
    [--exclude <otro.csv|ndjson>]... \\
    --output-dir <directorio nuevo>

Opciones del piloto:
  --case-limit 100
  --development-per-case 4
  --holdout-per-case 2
  --window-seconds 300
  --page-size 200
  --pages-per-contract 1
  --delay-ms 100
  --max-retries 6
  --seed tronsentinel-risk-set-v5
  --activity-anchor index|random-lookback
      index (v5, por defecto): controles activos en los window-seconds previos a la fecha índice.
      random-lookback (v6): cada control se busca activo en un instante aleatorio y determinista
      dentro de los anchor-max-days previos; evita que daysSinceLastTransfer sea ~0 por construcción.
  --anchor-max-days 90
  --dry-run

Requiere APP_TRONGRID_API_KEY o TRONGRID_API_KEY.
`;
}

function assertInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}_MUST_BE_INTEGER_${min}_TO_${max}`);
  }
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value); value = "";
    } else value += char;
  }
  values.push(value);
  return values;
}

async function readCsv(filePath) {
  const rows = [];
  const input = fs.createReadStream(filePath);
  const reader = readline.createInterface({input, crlfDelay: Infinity});
  let headers;
  for await (const line of reader) {
    if (!headers) { headers = parseCsvLine(line.replace(/^\uFEFF/, "")); continue; }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
  return rows;
}

async function readAddresses(filePath) {
  const addresses = new Set();
  if (path.extname(filePath).toLowerCase() === ".ndjson") {
    const reader = readline.createInterface({input: fs.createReadStream(filePath), crlfDelay: Infinity});
    for await (const line of reader) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const key of ["address", "from", "to"]) {
        if (ADDRESS_RE.test(String(row[key] || ""))) addresses.add(row[key]);
      }
    }
    return addresses;
  }
  for (const row of await readCsv(filePath)) {
    for (const key of ["address", "from", "to"]) {
      if (ADDRESS_RE.test(String(row[key] || ""))) addresses.add(row[key]);
    }
  }
  return addresses;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function base58Encode(buffer) {
  let number = BigInt(`0x${buffer.toString("hex")}`);
  let encoded = "";
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || "1";
}

function hexToTronAddress(value) {
  const clean = String(value || "").toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error("INVALID_HEX_ADDRESS");
  const payload = Buffer.from(`41${clean}`, "hex");
  const first = crypto.createHash("sha256").update(payload).digest();
  const second = crypto.createHash("sha256").update(first).digest();
  return base58Encode(Buffer.concat([payload, second.subarray(0, 4)]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function suspensionDelay(text) {
  const match = String(text).match(/suspended for\s+(\d+)\s*s/i);
  return match ? Number(match[1]) * 1000 : 0;
}

async function requestJson(url, apiKey, maxRetries) {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, {
      headers: {accept: "application/json", "TRON-PRO-API-KEY": apiKey},
    });
    const text = await response.text();
    if (response.ok) {
      const body = JSON.parse(text);
      if (body.success === false) throw new Error(`TRONGRID_ERROR:${text.slice(0, 500)}`);
      return body;
    }
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`HTTP_${response.status}:${text.slice(0, 500)}`);
    }
    if (attempt >= maxRetries) throw new Error(`HTTP_${response.status}_RETRIES_EXHAUSTED`);
    const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
    const waitMs = Math.max(retryAfter, suspensionDelay(text), 1000 * (2 ** attempt));
    await sleep(Math.min(waitMs, 30_000));
    attempt += 1;
  }
}

async function fetchCandidates({caseMs, anchorMs = caseMs, apiKey, options, stats}) {
  const candidates = new Map();
  if (anchorMs > caseMs) throw new Error("ANCHOR_AFTER_CASE_INDEX");
  const maxMs = anchorMs;
  const minMs = maxMs - options.windowSeconds * 1000;
  for (const contract of CONTRACTS) {
    let fingerprint;
    for (let page = 0; page < options.pagesPerContract; page += 1) {
      const url = new URL(`/v1/contracts/${contract.address}/events`, BASE_URL);
      url.searchParams.set("event_name", "Transfer");
      url.searchParams.set("only_confirmed", "true");
      url.searchParams.set("limit", String(options.pageSize));
      url.searchParams.set("order_by", "block_timestamp,desc");
      url.searchParams.set("min_block_timestamp", String(minMs));
      url.searchParams.set("max_block_timestamp", String(maxMs));
      if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
      const body = await requestJson(url, apiKey, options.maxRetries);
      const events = body.data || [];
      stats.requests += 1;
      stats.events += events.length;
      for (const event of events) {
        const eventMs = Number(event.block_timestamp);
        if (!Number.isFinite(eventMs) || eventMs > maxMs || eventMs < minMs) {
          stats.outOfWindowEvents += 1;
          continue;
        }
        for (const field of ["from", "to"]) {
          try {
            const address = hexToTronAddress(event.result?.[field]);
            if (!candidates.has(address)) {
              candidates.set(address, {
                address,
                eventAtUtc: new Date(eventMs).toISOString(),
                evidenceRef: `tx:${event.transaction_id}`,
                token: contract.symbol,
              });
            }
          } catch { stats.invalidEndpoints += 1; }
        }
      }
      fingerprint = body.meta?.fingerprint;
      if (!fingerprint || events.length < options.pageSize) break;
      await sleep(options.delayMs);
    }
    await sleep(options.delayMs);
  }
  return [...candidates.values()];
}

function evenlySpaced(rows, limit) {
  if (limit >= rows.length) return rows;
  const selected = [];
  const used = new Set();
  for (let index = 0; index < limit; index += 1) {
    const position = Math.floor(index * rows.length / limit);
    if (!used.has(position)) { selected.push(rows[position]); used.add(position); }
  }
  return selected;
}

function outputRow(caseRow, candidate, role, rank, seed) {
  const caseId = caseRow.matchedCaseId || caseRow.cohortId;
  const prefix = role === "DEVELOPMENT" ? "risk_control" : "risk_holdout";
  const id = sha256Text(`${seed}|${role}|${caseId}|${candidate.address}`).slice(0, 16);
  return {
    cohortId: `${prefix}_${id}`,
    matchedCaseId: caseId,
    address: candidate.address,
    target: 0,
    indexAtUtc: new Date(Date.parse(caseRow.indexAtUtc)).toISOString(),
    lookbackEndExclusiveUtc: new Date(Date.parse(caseRow.indexAtUtc)).toISOString(),
    evidenceRef: candidate.evidenceRef,
    source: "TRONGRID_ACTIVE_RISK_SET_V5",
    selectionRole: role,
    selectionRank: rank,
    activeEventAtUtc: candidate.eventAtUtc,
    activeToken: candidate.token,
  };
}

async function writeCsv(filePath, rows) {
  const headers = [
    "cohortId", "matchedCaseId", "address", "target", "indexAtUtc",
    "lookbackEndExclusiveUtc", "evidenceRef", "source", "selectionRole",
    "selectionRank", "activeEventAtUtc", "activeToken",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvValue(row[header])).join(","));
  await fsp.writeFile(filePath, `${lines.join("\n")}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  if (!options.cases || !options.labels || !options.outputDir) {
    throw new Error("CASES_LABELS_OUTPUT_DIR_REQUIRED\n" + usage());
  }
  assertInteger(options.caseLimit, "CASE_LIMIT", 1, 10_000);
  assertInteger(options.developmentPerCase, "DEVELOPMENT_PER_CASE", 1, 20);
  assertInteger(options.holdoutPerCase, "HOLDOUT_PER_CASE", 0, 20);
  assertInteger(options.windowSeconds, "WINDOW_SECONDS", 1, 86_400);
  assertInteger(options.pageSize, "PAGE_SIZE", 20, 200);
  assertInteger(options.pagesPerContract, "PAGES_PER_CONTRACT", 1, 50);
  assertInteger(options.delayMs, "DELAY_MS", 0, 60_000);
  assertInteger(options.maxRetries, "MAX_RETRIES", 0, 20);
  assertInteger(options.anchorMaxDays, "ANCHOR_MAX_DAYS", 1, 365);
  if (!["index", "random-lookback"].includes(options.activityAnchor)) throw new Error("ACTIVITY_ANCHOR_INVALID");

  const outputDir = path.resolve(options.outputDir);
  try { await fsp.access(outputDir); throw new Error(`OUTPUT_ALREADY_EXISTS:${outputDir}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const casesPath = path.resolve(options.cases);
  const labelsPath = path.resolve(options.labels);
  const excludePaths = options.excludes.map((value) => path.resolve(value));
  const [datasetRows, labelAddresses, ...extraAddressSets] = await Promise.all([
    readCsv(casesPath), readAddresses(labelsPath), ...excludePaths.map(readAddresses),
  ]);
  const positives = datasetRows
    .filter((row) => Number(row.target) === 1 && ADDRESS_RE.test(row.address) && Number.isFinite(Date.parse(row.indexAtUtc)))
    .sort((a, b) => Date.parse(a.indexAtUtc) - Date.parse(b.indexAtUtc) || a.address.localeCompare(b.address));
  const uniqueCases = [...new Map(positives.map((row) => [row.address, row])).values()];
  const selectedCases = evenlySpaced(uniqueCases, Math.min(options.caseLimit, uniqueCases.length));
  const excluded = new Set(CONTRACTS.map((contract) => contract.address));
  for (const row of datasetRows) if (ADDRESS_RE.test(row.address)) excluded.add(row.address);
  for (const address of labelAddresses) excluded.add(address);
  for (const set of extraAddressSets) for (const address of set) excluded.add(address);

  const plan = {
    ok: true,
    dryRun: options.dryRun,
    design: options.activityAnchor === "index"
      ? "active-wallet-risk-set-immediately-before-case-index-v5"
      : "active-wallet-risk-set-random-lookback-anchor-v6",
    activityAnchor: options.activityAnchor,
    anchorMaxDays: options.activityAnchor === "index" ? null : options.anchorMaxDays,
    sourceCases: uniqueCases.length,
    selectedCases: selectedCases.length,
    developmentPerCase: options.developmentPerCase,
    holdoutPerCase: options.holdoutPerCase,
    windowSeconds: options.windowSeconds,
    pageSize: options.pageSize,
    pagesPerContract: options.pagesPerContract,
    contracts: CONTRACTS,
    excludedAddresses: excluded.size,
    seed: options.seed,
    casesSha256: await sha256File(casesPath),
    labelsSha256: await sha256File(labelsPath),
    excludeFiles: await Promise.all(excludePaths.map(async (file) => ({file, sha256: await sha256File(file)}))),
    outputDir,
  };
  if (options.dryRun) { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return; }

  const apiKey = String(process.env.APP_TRONGRID_API_KEY || process.env.TRONGRID_API_KEY || "").trim();
  if (!apiKey) throw new Error("APP_TRONGRID_API_KEY_OR_TRONGRID_API_KEY_REQUIRED");
  await fsp.mkdir(outputDir, {recursive: false});
  await fsp.writeFile(path.join(outputDir, "risk-set-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

  const development = [];
  const holdout = [];
  const evidence = [];
  const used = new Set();
  const shortfalls = [];
  const stats = {requests: 0, events: 0, invalidEndpoints: 0, outOfWindowEvents: 0};
  const required = options.developmentPerCase + options.holdoutPerCase;

  for (let index = 0; index < selectedCases.length; index += 1) {
    const caseRow = selectedCases[index];
    const caseMs = Date.parse(caseRow.indexAtUtc);
    const order = (a, b) => sha256Text(`${options.seed}|${caseRow.cohortId}|${a.address}`)
      .localeCompare(sha256Text(`${options.seed}|${caseRow.cohortId}|${b.address}`));
    let chosen = [];
    let rawCount = 0;
    let eligibleCount = 0;
    if (options.activityAnchor === "index") {
      const rawCandidates = await fetchCandidates({caseMs, apiKey, options, stats});
      const eligible = rawCandidates
        .filter((candidate) => !excluded.has(candidate.address) && !used.has(candidate.address))
        .sort(order);
      chosen = eligible.slice(0, required).map((candidate) => ({...candidate, anchorAtUtc: new Date(caseMs).toISOString()}));
      rawCount = rawCandidates.length;
      eligibleCount = eligible.length;
    } else {
      for (let slot = 0; slot < required; slot += 1) {
        const fraction = parseInt(sha256Text(`${options.seed}|${caseRow.cohortId}|anchor|${slot}`).slice(0, 12), 16) / 2 ** 48;
        const anchorMs = caseMs - Math.floor(fraction * options.anchorMaxDays * 86_400_000);
        const rawCandidates = await fetchCandidates({caseMs, anchorMs, apiKey, options, stats});
        const taken = new Set(chosen.map((candidate) => candidate.address));
        const eligible = rawCandidates
          .filter((candidate) => !excluded.has(candidate.address) && !used.has(candidate.address) && !taken.has(candidate.address))
          .sort(order);
        rawCount += rawCandidates.length;
        eligibleCount += eligible.length;
        if (eligible.length) chosen.push({...eligible[0], anchorAtUtc: new Date(anchorMs).toISOString()});
      }
    }
    if (chosen.length < required) {
      shortfalls.push({caseId: caseRow.cohortId, address: caseRow.address, required, available: chosen.length});
    }
    chosen.forEach((candidate, position) => {
      used.add(candidate.address);
      const role = position < options.developmentPerCase ? "DEVELOPMENT" : "EXTERNAL_HOLDOUT";
      const rank = role === "DEVELOPMENT" ? position + 1 : position - options.developmentPerCase + 1;
      const row = outputRow(caseRow, candidate, role, rank, options.seed);
      (role === "DEVELOPMENT" ? development : holdout).push(row);
      evidence.push({
        caseId: caseRow.cohortId,
        caseAddress: caseRow.address,
        caseIndexAtUtc: row.indexAtUtc,
        selectedAddress: candidate.address,
        selectionRole: role,
        selectionRank: rank,
        activeEventAtUtc: candidate.eventAtUtc,
        activeToken: candidate.token,
        evidenceRef: candidate.evidenceRef,
        anchorAtUtc: candidate.anchorAtUtc,
        candidateCountBeforeExclusions: rawCount,
        eligibleCandidateCount: eligibleCount,
      });
    });
    process.stderr.write(
      `${index + 1}/${selectedCases.length} ${caseRow.cohortId} candidates=${rawCount} eligible=${eligibleCount} selected=${chosen.length}\n`,
    );
  }

  const developmentPath = path.join(outputDir, "risk-set-development-controls-v5.csv");
  const holdoutPath = path.join(outputDir, "risk-set-external-holdout-v5.csv");
  const evidencePath = path.join(outputDir, "risk-set-selection-evidence-v5.ndjson");
  await writeCsv(developmentPath, development);
  await writeCsv(holdoutPath, holdout);
  await fsp.writeFile(evidencePath, evidence.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const summary = {
    ...plan,
    dryRun: false,
    developmentControls: development.length,
    externalHoldoutControls: holdout.length,
    uniqueSelectedAddresses: used.size,
    casesWithShortfall: shortfalls.length,
    shortfalls,
    queryStats: stats,
    temporalValidation: {
      futureEvents: evidence.filter((row) => Date.parse(row.activeEventAtUtc) > Date.parse(row.caseIndexAtUtc)).length,
      exactCaseIndexAssigned: true,
    },
    outputs: {development: developmentPath, externalHoldout: holdoutPath, evidence: evidencePath},
    readyForHistoryDownload: shortfalls.length === 0,
    trainingSafeAtSelectionStage: shortfalls.length === 0 && stats.outOfWindowEvents === 0,
    generatedAtUtc: new Date().toISOString(),
  };
  await fsp.writeFile(path.join(outputDir, "risk-set-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
