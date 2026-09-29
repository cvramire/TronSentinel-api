import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {pathToFileURL} from "node:url";
import {FEATURE_NAMES, FEATURE_SET_VERSION} from "./build-point-in-time-snapshots.mjs";

const FORBIDDEN = /(blacklist|blocklist|ofac|tatum|risk.?score|risk.?level|tagged.?malicious|security.?status|label)/i;

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function validateDataset(directory) {
  const root = path.resolve(directory);
  const manifestPath = path.join(root, "dataset_manifest.json");
  const ndjsonPath = path.join(root, "ts_feature_snapshots.ndjson");
  const csvPath = path.join(root, "ts_feature_snapshots.csv");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const reader = readline.createInterface({
    input: fs.createReadStream(ndjsonPath),
    crlfDelay: Infinity,
  });
  const snapshotIds = new Set();
  const addresses = new Set();
  const splitCounts = {train: 0, validation: 0, test: 0};
  let rows = 0;

  for await (const line of reader) {
    if (!line.trim()) continue;
    rows += 1;
    const snapshot = JSON.parse(line);
    if (snapshot.featureSetVersion !== FEATURE_SET_VERSION) {
      throw new Error(`FEATURE_SET_MISMATCH_AT_ROW:${rows}`);
    }
    if (snapshotIds.has(snapshot.snapshotId)) throw new Error(`DUPLICATE_SNAPSHOT_ID:${snapshot.snapshotId}`);
    snapshotIds.add(snapshot.snapshotId);
    addresses.add(snapshot.address);
    if (!(snapshot.datasetSplit in splitCounts)) throw new Error(`INVALID_SPLIT_AT_ROW:${rows}`);
    splitCounts[snapshot.datasetSplit] += 1;
    const names = Object.keys(snapshot.features).sort();
    const expected = [...FEATURE_NAMES].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`FEATURE_SCHEMA_MISMATCH_AT_ROW:${rows}`);
    }
    if (names.some((name) => FORBIDDEN.test(name))) throw new Error(`FORBIDDEN_FEATURE_AT_ROW:${rows}`);
    if (!Object.values(snapshot.features).every(Number.isFinite)) {
      throw new Error(`NON_FINITE_FEATURE_AT_ROW:${rows}`);
    }
    if (snapshot.targetBlacklistedFuture !== null ||
        snapshot.labelStatus !== "UNLABELED_BLACKLIST_OUTCOME") {
      throw new Error(`UNEXPECTED_LABEL_AT_ROW:${rows}`);
    }
  }

  const ndjsonHash = await sha256(ndjsonPath);
  const csvHash = await sha256(csvPath);
  if (ndjsonHash !== manifest.files.ndjson.sha256) throw new Error("NDJSON_HASH_MISMATCH");
  if (csvHash !== manifest.files.csv.sha256) throw new Error("CSV_HASH_MISMATCH");
  if (rows !== manifest.rows) throw new Error("ROW_COUNT_MISMATCH");
  if (addresses.size !== manifest.uniqueWallets) throw new Error("WALLET_COUNT_MISMATCH");
  if (JSON.stringify(splitCounts) !== JSON.stringify(manifest.splitCounts)) {
    throw new Error("SPLIT_COUNT_MISMATCH");
  }

  const report = {
    ok: true,
    validatedAtUtc: new Date().toISOString(),
    rows,
    uniqueWallets: addresses.size,
    uniqueSnapshotIds: snapshotIds.size,
    featureCount: FEATURE_NAMES.length,
    splitCounts,
    labelsReady: false,
    ndjsonSha256: ndjsonHash,
    csvSha256: csvHash,
  };
  await fsp.writeFile(
    path.join(root, "validation_report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  if (!directory) {
    process.stderr.write("Uso: node scripts/validate-point-in-time-snapshots.mjs /ruta/dataset\n");
    process.exitCode = 1;
  } else {
    validateDataset(directory)
      .then((result) => process.stdout.write(JSON.stringify(result, null, 2) + "\n"))
      .catch((error) => {
        process.stderr.write(`${error?.stack || error}\n`);
        process.exitCode = 1;
      });
  }
}
