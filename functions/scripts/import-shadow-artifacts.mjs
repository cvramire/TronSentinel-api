#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import admin from "firebase-admin";
import {parseCsvLine} from "./build-point-in-time-snapshots.mjs";

function parseArgs(argv) {
  const options = {commit: false, activate: false};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") options.model = argv[++index];
    else if (arg === "--dataset") options.dataset = argv[++index];
    else if (arg === "--project-id") options.projectId = argv[++index];
    else if (arg === "--commit") options.commit = true;
    else if (arg === "--activate") options.activate = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!options.model || !options.dataset || !options.projectId) throw new Error("MODEL_DATASET_PROJECT_REQUIRED");
  if (options.activate && !options.commit) throw new Error("ACTIVATE_REQUIRES_COMMIT");
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = JSON.parse(await fsp.readFile(path.resolve(options.model), "utf8"));
  if (model.status !== "CHALLENGER" || model.deploymentMode !== "SHADOW" ||
      model.productionProbabilityReady !== false || !model.governance?.shadowDeploymentAllowed) {
    throw new Error("MODEL_NOT_SHADOW_DEPLOYABLE");
  }
  const rows = await readCsv(path.resolve(options.dataset));
  const meta = new Set(["cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target"]);
  const featureNames = Object.keys(rows[0] || {}).filter((name) => !meta.has(name));
  if (JSON.stringify(featureNames) !== JSON.stringify(model.featureNames)) throw new Error("FEATURE_ORDER_MISMATCH");
  const modelDocumentId = model.artifactVersion;
  const plan = {
    projectId: options.projectId,
    modelDocumentId,
    modelVersion: model.modelVersion,
    artifactVersion: model.artifactVersion,
    snapshots: rows.length,
    collection: "ts_onchain_feature_snapshots",
    activate: options.activate,
    commit: options.commit,
  };
  if (!options.commit) {
    process.stdout.write(`${JSON.stringify({ok: true, dryRun: true, ...plan}, null, 2)}\n`);
    return;
  }
  if (!admin.apps.length) admin.initializeApp({projectId: options.projectId});
  const db = admin.firestore();
  await db.collection("ts_model_registry").doc(modelDocumentId).set(model);
  let batch = db.batch();
  let pending = 0;
  let written = 0;
  for (const row of rows) {
    const features = Object.fromEntries(featureNames.map((name) => [name, Number(row[name])]));
    if (Object.values(features).some((value) => !Number.isFinite(value))) throw new Error(`NON_FINITE_FEATURE:${row.cohortId}`);
    const snapshotId = `shadow_${row.cohortId}`;
    batch.set(db.collection("ts_onchain_feature_snapshots").doc(snapshotId), {
      snapshotId,
      cohortId: row.cohortId,
      matchedCaseId: row.matchedCaseId,
      address: row.address,
      snapshotAtMs: Date.parse(row.indexAtUtc),
      featureSetVersion: model.featureSetVersion,
      features,
      datasetSplit: row.datasetSplit,
      importedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    pending += 1;
    written += 1;
    if (pending >= 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
      process.stdout.write(`${written}/${rows.length} snapshots\n`);
    }
  }
  if (pending) await batch.commit();
  if (options.activate) {
    await db.collection("ts_model_control").doc("current").set({
      shadowModelVersion: modelDocumentId,
      shadowActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  }
  process.stdout.write(`${JSON.stringify({ok: true, ...plan, written}, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
