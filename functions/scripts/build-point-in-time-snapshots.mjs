import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {pathToFileURL} from "node:url";

export const FEATURE_SET_VERSION = "tron-wallet-behavior-2.0.0";
export const FEATURE_NAMES = [
  "walletAgeDays",
  "eventCount1d",
  "eventCount7d",
  "eventCount30d",
  "eventCount90d",
  "uniqueTxCount7d",
  "uniqueTxCount30d",
  "uniqueTxCount90d",
  "activeDays30d",
  "activeDays90d",
  "amountSum1d",
  "amountSum7d",
  "amountSum30d",
  "amountSum90d",
  "amountMax30d",
  "amountMax90d",
  "amountAverage30d",
  "amountAverage90d",
  "newWhaleCount30d",
  "newWhaleCount90d",
  "accumulationCount30d",
  "accumulationCount90d",
  "distributionCount30d",
  "distributionCount90d",
  "patternTxCountSum30d",
  "patternTxCountSum90d",
  "eventsPerActiveDay30d",
  "eventsPerActiveDay90d",
  "newWhaleRatio90d",
  "accumulationRatio90d",
  "distributionRatio90d",
  "volumeVelocity7d",
  "recentToLongVolumeRatio",
];

const DAY_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_SOURCE_FIELDS = [
  "legacy_risk_score_raw",
  "legacy_risk_score_capped_100",
  "legacy_risk_level",
  "label_status",
  "target_blacklisted_future",
];

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

function csvValue(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

class RollingWindow {
  constructor(days) {
    this.durationMs = days * DAY_MS;
    this.events = [];
    this.head = 0;
    this.amountSum = 0;
    this.patternTxCountSum = 0;
    this.typeCounts = {new_whale: 0, accumulation: 0, distribution: 0};
    this.txCounts = new Map();
    this.dayCounts = new Map();
    this.maxDeque = [];
    this.maxHead = 0;
  }

  add(event) {
    this.events.push(event);
    this.amountSum += event.amount;
    this.patternTxCountSum += event.patternTxCount;
    this.typeCounts[event.eventType] = (this.typeCounts[event.eventType] || 0) + 1;
    this.txCounts.set(event.txHash, (this.txCounts.get(event.txHash) || 0) + 1);
    this.dayCounts.set(event.eventDate, (this.dayCounts.get(event.eventDate) || 0) + 1);
    while (this.maxDeque.length > this.maxHead &&
           this.maxDeque[this.maxDeque.length - 1].amount <= event.amount) {
      this.maxDeque.pop();
    }
    this.maxDeque.push(event);
    this.prune(event.timestampMs);
  }

  prune(nowMs) {
    const minimum = nowMs - this.durationMs;
    while (this.head < this.events.length && this.events[this.head].timestampMs < minimum) {
      const expired = this.events[this.head];
      this.head += 1;
      this.amountSum -= expired.amount;
      this.patternTxCountSum -= expired.patternTxCount;
      this.typeCounts[expired.eventType] -= 1;
      this.decrement(this.txCounts, expired.txHash);
      this.decrement(this.dayCounts, expired.eventDate);
      if (this.maxDeque[this.maxHead]?.sequence === expired.sequence) this.maxHead += 1;
    }
    if (this.head > 2048 && this.head > this.events.length / 2) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
    if (this.maxHead > 2048 && this.maxHead > this.maxDeque.length / 2) {
      this.maxDeque = this.maxDeque.slice(this.maxHead);
      this.maxHead = 0;
    }
  }

  decrement(map, key) {
    const next = (map.get(key) || 0) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  snapshot() {
    const count = this.events.length - this.head;
    return {
      count,
      uniqueTxCount: this.txCounts.size,
      activeDays: this.dayCounts.size,
      amountSum: Math.max(0, this.amountSum),
      amountMax: this.maxDeque[this.maxHead]?.amount || 0,
      amountAverage: ratio(this.amountSum, count),
      patternTxCountSum: Math.max(0, this.patternTxCountSum),
      newWhaleCount: this.typeCounts.new_whale || 0,
      accumulationCount: this.typeCounts.accumulation || 0,
      distributionCount: this.typeCounts.distribution || 0,
    };
  }
}

export function buildFeatureVector(firstEventMs, event, windows) {
  const one = windows.one.snapshot();
  const seven = windows.seven.snapshot();
  const thirty = windows.thirty.snapshot();
  const ninety = windows.ninety.snapshot();
  return {
    walletAgeDays: Math.max(0, (event.timestampMs - firstEventMs) / DAY_MS),
    eventCount1d: one.count,
    eventCount7d: seven.count,
    eventCount30d: thirty.count,
    eventCount90d: ninety.count,
    uniqueTxCount7d: seven.uniqueTxCount,
    uniqueTxCount30d: thirty.uniqueTxCount,
    uniqueTxCount90d: ninety.uniqueTxCount,
    activeDays30d: thirty.activeDays,
    activeDays90d: ninety.activeDays,
    amountSum1d: one.amountSum,
    amountSum7d: seven.amountSum,
    amountSum30d: thirty.amountSum,
    amountSum90d: ninety.amountSum,
    amountMax30d: thirty.amountMax,
    amountMax90d: ninety.amountMax,
    amountAverage30d: thirty.amountAverage,
    amountAverage90d: ninety.amountAverage,
    newWhaleCount30d: thirty.newWhaleCount,
    newWhaleCount90d: ninety.newWhaleCount,
    accumulationCount30d: thirty.accumulationCount,
    accumulationCount90d: ninety.accumulationCount,
    distributionCount30d: thirty.distributionCount,
    distributionCount90d: ninety.distributionCount,
    patternTxCountSum30d: thirty.patternTxCountSum,
    patternTxCountSum90d: ninety.patternTxCountSum,
    eventsPerActiveDay30d: ratio(thirty.count, thirty.activeDays),
    eventsPerActiveDay90d: ratio(ninety.count, ninety.activeDays),
    newWhaleRatio90d: ratio(ninety.newWhaleCount, ninety.count),
    accumulationRatio90d: ratio(ninety.accumulationCount, ninety.count),
    distributionRatio90d: ratio(ninety.distributionCount, ninety.count),
    volumeVelocity7d: seven.amountSum / 7,
    recentToLongVolumeRatio: ratio(seven.amountSum, ninety.amountSum),
  };
}

function parseArgs(argv) {
  const options = {input: "", outputDir: "", maxRows: 0};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") options.input = argv[++index] || "";
    else if (value === "--output-dir") options.outputDir = argv[++index] || "";
    else if (value === "--max-rows") options.maxRows = Number(argv[++index] || 0);
    else if (value === "--help") options.help = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${value}`);
  }
  return options;
}

function help() {
  return `Uso:\n  node scripts/build-point-in-time-snapshots.mjs \\\n+    --input /ruta/events_clean.csv \\\n+    --output-dir /ruta/salida \\\n+    [--max-rows 5000]\n`;
}

async function readEvents(inputPath, maxRows) {
  const stream = fs.createReadStream(inputPath);
  const reader = readline.createInterface({input: stream, crlfDelay: Infinity});
  let headers = null;
  const events = [];
  let rowNumber = 0;

  for await (const line of reader) {
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (!line.trim()) continue;
    rowNumber += 1;
    if (maxRows > 0 && rowNumber > maxRows) break;
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const timestampMs = Date.parse(row.event_timestamp_utc);
    if (!Number.isFinite(timestampMs)) throw new Error(`INVALID_TIMESTAMP_AT_ROW:${rowNumber + 1}`);
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(row.address)) {
      throw new Error(`INVALID_ADDRESS_AT_ROW:${rowNumber + 1}`);
    }
    const amount = Math.max(0, finite(row.event_amount_usdt || row.pattern_total_usdt, 0));
    events.push({
      sourceDocId: row.source_doc_id,
      address: row.address,
      timestampMs,
      eventDate: row.event_date || new Date(timestampMs).toISOString().slice(0, 10),
      blockNumber: finite(row.block_number, 0),
      txHash: row.tx_hash || row.source_doc_id,
      eventType: row.event_type,
      amount,
      patternTxCount: Math.max(0, finite(row.pattern_tx_count, 0)),
    });
  }
  if (events.length === 0) throw new Error("SOURCE_HAS_NO_EVENTS");
  return events;
}

function splitCutoffs(events) {
  const times = events.map((event) => event.timestampMs).sort((a, b) => a - b);
  return {
    trainEndMs: times[Math.max(0, Math.ceil(times.length * 0.70) - 1)],
    validationEndMs: times[Math.max(0, Math.ceil(times.length * 0.85) - 1)],
  };
}

function splitFor(timestampMs, cutoffs) {
  if (timestampMs <= cutoffs.trainEndMs) return "train";
  if (timestampMs <= cutoffs.validationEndMs) return "validation";
  return "test";
}

async function writeDataset(events, inputPath, outputDir) {
  await fsp.mkdir(outputDir, {recursive: true});
  const ndjsonPath = path.join(outputDir, "ts_feature_snapshots.ndjson");
  const csvPath = path.join(outputDir, "ts_feature_snapshots.csv");
  const manifestPath = path.join(outputDir, "dataset_manifest.json");
  const ndjson = fs.createWriteStream(ndjsonPath);
  const csv = fs.createWriteStream(csvPath);
  const cutoffs = splitCutoffs(events);
  const splitCounts = {train: 0, validation: 0, test: 0};
  let walletCount = 0;
  let snapshotCount = 0;

  csv.write([
    "snapshotId", "address", "snapshotAtMs", "snapshotAtUtc", "sourceDocId",
    "sourceTxHash", "sourceBlockNumber", "featureSetVersion", "datasetSplit",
    "labelStatus", "targetBlacklistedFuture", ...FEATURE_NAMES,
  ].join(",") + "\n");

  events.sort((a, b) =>
    a.address.localeCompare(b.address) ||
    a.timestampMs - b.timestampMs ||
    a.sourceDocId.localeCompare(b.sourceDocId),
  );

  let currentAddress = "";
  let firstEventMs = 0;
  let sequence = 0;
  let windows = null;

  for (const event of events) {
    if (event.address !== currentAddress) {
      currentAddress = event.address;
      firstEventMs = event.timestampMs;
      sequence = 0;
      walletCount += 1;
      windows = {
        one: new RollingWindow(1),
        seven: new RollingWindow(7),
        thirty: new RollingWindow(30),
        ninety: new RollingWindow(90),
      };
    }
    sequence += 1;
    const windowEvent = {...event, sequence};
    windows.one.add(windowEvent);
    windows.seven.add(windowEvent);
    windows.thirty.add(windowEvent);
    windows.ninety.add(windowEvent);
    const features = buildFeatureVector(firstEventMs, windowEvent, windows);
    const snapshotId = sha256(`${event.address}:${event.timestampMs}:${event.sourceDocId}:${FEATURE_SET_VERSION}`).slice(0, 40);
    const datasetSplit = splitFor(event.timestampMs, cutoffs);
    splitCounts[datasetSplit] += 1;
    snapshotCount += 1;
    const snapshot = {
      snapshotId,
      chain: "tron-mainnet",
      asset: "USDT_TRC20",
      address: event.address,
      snapshotAtMs: event.timestampMs,
      snapshotAtUtc: new Date(event.timestampMs).toISOString(),
      sourceDocId: event.sourceDocId,
      sourceTxHash: event.txHash,
      sourceBlockNumber: event.blockNumber,
      featureSetVersion: FEATURE_SET_VERSION,
      datasetSplit,
      labelStatus: "UNLABELED_BLACKLIST_OUTCOME",
      targetBlacklistedFuture: null,
      features,
    };
    ndjson.write(JSON.stringify(snapshot) + "\n");
    csv.write([
      snapshot.snapshotId,
      snapshot.address,
      snapshot.snapshotAtMs,
      snapshot.snapshotAtUtc,
      snapshot.sourceDocId,
      snapshot.sourceTxHash,
      snapshot.sourceBlockNumber,
      snapshot.featureSetVersion,
      snapshot.datasetSplit,
      snapshot.labelStatus,
      "",
      ...FEATURE_NAMES.map((name) => features[name]),
    ].map(csvValue).join(",") + "\n");
  }

  await Promise.all([
    new Promise((resolve, reject) => ndjson.end((error) => error ? reject(error) : resolve())),
    new Promise((resolve, reject) => csv.end((error) => error ? reject(error) : resolve())),
  ]);

  const manifest = {
    datasetVersion: "tronsentinel-point-in-time-0.2.0-unlabeled",
    generatedAtUtc: new Date().toISOString(),
    sourceFile: path.basename(inputPath),
    sourceSha256: await fileSha256(inputPath),
    featureSetVersion: FEATURE_SET_VERSION,
    featureNames: FEATURE_NAMES,
    leakageExcludedFields: FORBIDDEN_SOURCE_FIELDS,
    snapshotBoundary: "Includes the current source event and excludes every later event.",
    temporalSplit: {
      strategy: "global chronological 70/15/15",
      trainEndUtc: new Date(cutoffs.trainEndMs).toISOString(),
      validationEndUtc: new Date(cutoffs.validationEndMs).toISOString(),
    },
    rows: snapshotCount,
    uniqueWallets: walletCount,
    splitCounts,
    labelReadiness: "BLOCKED_MISSING_HISTORICAL_BLACKLIST_LABELS",
    files: {
      ndjson: {name: path.basename(ndjsonPath), sha256: await fileSha256(ndjsonPath)},
      csv: {name: path.basename(csvPath), sha256: await fileSha256(csvPath)},
    },
  };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return {ndjsonPath, csvPath, manifestPath, manifest};
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  if (!options.input || !options.outputDir) throw new Error("INPUT_AND_OUTPUT_DIR_REQUIRED");
  const inputPath = path.resolve(options.input);
  const outputDir = path.resolve(options.outputDir);
  const events = await readEvents(inputPath, options.maxRows);
  const result = await writeDataset(events, inputPath, outputDir);
  process.stdout.write(JSON.stringify({
    ok: true,
    rows: result.manifest.rows,
    uniqueWallets: result.manifest.uniqueWallets,
    splitCounts: result.manifest.splitCounts,
    outputDir,
  }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
