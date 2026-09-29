#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { FieldPath, getFirestore } from "firebase-admin/firestore";

const EXPORT_SCHEMA_VERSION = "wallet-alert-firestore-export-1.0.0";
const DEFAULT_COLLECTIONS = ["intelligenceAlerts", "feature_snapshots", "label_history"];
const AUDIT_COLLECTIONS = ["assessments", "historialAnalizador"];
const ALLOWED_COLLECTIONS = new Set([...DEFAULT_COLLECTIONS, ...AUDIT_COLLECTIONS]);
const FEATURE_NAMES = [
  "senderAgeRisk", "activityRisk", "counterpartyRisk", "collectorRisk", "disperserRisk",
  "amountRisk", "contractRisk", "allowanceRisk", "tokenRisk", "blacklistExposure",
];

const ALWAYS_REDACT_KEYS = new Set([
  "mnemonic", "privatekey", "private_key", "password", "secret",
  "bot_token", "bottoken", "authorization", "app_risk_admin_secret", "apikey", "api_key",
  "access_token", "refreshtoken", "refresh_token", "webhooksecret", "webhook_secret",
]);
const USER_IDENTIFIER_KEYS = new Set([
  "userids", "userid", "uid", "email", "chatid", "phone", "phonenumber",
  "displayname", "photourl", "fcm", "fcmtoken", "tokensfcm", "actor",
]);

const CSV_SCHEMAS = {
  intelligenceAlerts: [
    "source_doc_id", "address", "block_number", "created_at_utc", "risk_level_legacy",
    "risk_score_legacy", "total_usdt", "tx_count", "tx_hash", "event_type",
    "user_count", "user_ids_json", "exported_at_utc", "extras_json",
  ],
  feature_snapshots: [
    "source_doc_id", "snapshot_id", "address", "snapshot_at_ms", "snapshot_at_utc",
    "snapshot_day", "chain", "asset", "source", "object_id", "feature_set_version",
    "sender_age_risk", "activity_risk", "counterparty_risk", "collector_risk",
    "disperser_risk", "amount_risk", "contract_risk", "allowance_risk", "token_risk",
    "blacklist_exposure", "created_at_utc", "updated_at_utc", "exported_at_utc", "extras_json",
  ],
  label_history: [
    "source_doc_id", "label_id", "address", "chain", "source", "category",
    "published_at_ms", "published_at_utc", "effective_at_ms", "effective_at_utc",
    "observed_at_ms", "observed_at_utc", "valid_from_ms", "valid_from_utc",
    "valid_to_ms", "valid_to_utc", "label_confidence", "evidence_ref", "revoked",
    "label_version", "created_at_utc", "updated_at_utc", "exported_at_utc", "extras_json",
  ],
  assessments: [
    "source_doc_id", "tx_id", "timestamp_utc", "chain", "monitor_address", "from_address",
    "amount", "currency", "risk_bucket", "risk_score", "risk_probability", "model_version",
    "feature_set_version", "ai_model_version", "created_at_utc", "exported_at_utc", "extras_json",
  ],
  historialAnalizador: [
    "source_doc_id", "analysis_id", "address", "created_at_utc", "risk_level",
    "risk_score", "model_version", "feature_set_version", "exported_at_utc", "extras_json",
  ],
};

function usage() {
  return `
Exportador de datos Firestore para Wallet Alert Risk AI

Uso:
  npm run export:risk-data -- [opciones]

Autenticación:
  Configure GOOGLE_APPLICATION_CREDENTIALS con una cuenta de servicio de sólo lectura,
  o ejecute el comando en Google Cloud con Application Default Credentials.

Opciones:
  --project-id <id>             Proyecto. Default: GCLOUD_PROJECT o walletalert-f063b
  --database-id <id>            Base Firestore. Default: (default)
  --output <ruta>               Directorio nuevo. Default: exports/risk-data-<UTC>
  --collections <a,b,c>         Colecciones permitidas
  --include-audit               Agrega assessments e historialAnalizador
  --include-user-identifiers    Conserva userIds/uid/email. No recomendado
  --from <ISO-8601>             Fecha inicial inclusiva
  --to <ISO-8601>               Fecha final inclusiva
  --page-size <n>               Default: 500; máximo: 1000
  --max-docs <n>                Límite por colección para pruebas; marca truncado
  --help                        Muestra esta ayuda

Salida:
  raw/<coleccion>.ndjson        Estructura normalizada con redacción de privacidad
  csv/<coleccion>.csv           Vista tabular para procesamiento
  manifest.json                 Conteos, fechas, campos, tamaños y SHA-256

El script nunca modifica Firestore y exige un directorio de salida nuevo.
`;
}

function readValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requiere un valor`);
  return value;
}

function parseDate(value, name) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${name} debe ser una fecha ISO-8601 válida`);
  return ms;
}

function parseInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "walletalert-f063b",
    databaseId: "(default)", output: null, collections: [...DEFAULT_COLLECTIONS],
    includeAudit: false, includeUserIdentifiers: false, fromMs: null, toMs: null,
    pageSize: 500, maxDocs: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--project-id") options.projectId = readValue(argv, i++, arg);
    else if (arg === "--database-id") options.databaseId = readValue(argv, i++, arg);
    else if (arg === "--output") options.output = readValue(argv, i++, arg);
    else if (arg === "--collections") options.collections = readValue(argv, i++, arg).split(",").map((x) => x.trim()).filter(Boolean);
    else if (arg === "--include-audit") options.includeAudit = true;
    else if (arg === "--include-user-identifiers") options.includeUserIdentifiers = true;
    else if (arg === "--from") options.fromMs = parseDate(readValue(argv, i++, arg), arg);
    else if (arg === "--to") options.toMs = parseDate(readValue(argv, i++, arg), arg);
    else if (arg === "--page-size") options.pageSize = parseInteger(readValue(argv, i++, arg), arg, 1, 1000);
    else if (arg === "--max-docs") options.maxDocs = parseInteger(readValue(argv, i++, arg), arg, 1, 10_000_000);
    else throw new Error(`Opción no reconocida: ${arg}`);
  }
  if (options.includeAudit) options.collections.push(...AUDIT_COLLECTIONS);
  options.collections = [...new Set(options.collections)];
  for (const collection of options.collections) {
    if (!ALLOWED_COLLECTIONS.has(collection)) {
      throw new Error(`Colección no permitida: ${collection}. Permitidas: ${[...ALLOWED_COLLECTIONS].join(", ")}`);
    }
  }
  if (options.fromMs != null && options.toMs != null && options.fromMs > options.toMs) {
    throw new Error("--from no puede ser posterior a --to");
  }
  return options;
}

function isTimestampLike(value) {
  return value && typeof value === "object" &&
    (typeof value.toDate === "function" || typeof value.toMillis === "function" ||
      typeof value._seconds === "number" || typeof value.seconds === "number");
}

export function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 0 && value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value?.toMillis === "function") return value.toMillis();
  const seconds = value?._seconds ?? value?.seconds;
  const nanos = value?._nanoseconds ?? value?.nanoseconds ?? 0;
  if (typeof seconds === "number") return Math.round(seconds * 1000 + nanos / 1_000_000);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function iso(value) {
  const ms = toMillis(value);
  return ms == null ? null : new Date(ms).toISOString();
}

export function normalizeFirestoreValue(value, options = {}) {
  const includeUserIdentifiers = Boolean(options.includeUserIdentifiers);
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date || isTimestampLike(value)) return iso(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { _type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (typeof value?.latitude === "number" && typeof value?.longitude === "number") {
    return { _type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  }
  if (typeof value?.path === "string" && value?.firestore) return { _type: "document_reference", path: value.path };
  if (Array.isArray(value)) return value.map((item) => normalizeFirestoreValue(item, options));
  if (typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (ALWAYS_REDACT_KEYS.has(lower)) output[key] = "[REDACTED_SECRET]";
      else if (!includeUserIdentifiers && USER_IDENTIFIER_KEYS.has(lower)) {
        output[key] = Array.isArray(child)
          ? { _redacted: "USER_IDENTIFIER_LIST", count: child.length }
          : "[REDACTED_USER_IDENTIFIER]";
      }
      else output[key] = normalizeFirestoreValue(child, options);
    }
    return output;
  }
  return String(value);
}

export function csvEscape(value) {
  if (value == null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeJson(value) { return value == null ? "" : JSON.stringify(value); }
function numeric(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function toSnake(value) { return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`); }
function withoutKeys(data, keys) {
  const output = {};
  for (const [key, value] of Object.entries(data || {})) if (!keys.has(key)) output[key] = value;
  return output;
}

function flattenForCsv(collection, documentId, data, exportedAt) {
  if (collection === "intelligenceAlerts") {
    const known = new Set(["address", "blockNumber", "createdAt", "riskLevel", "riskScore", "totalUsdt", "txCount", "txHash", "type", "userIds"]);
    const userIds = Array.isArray(data.userIds) ? data.userIds : null;
    const redactedUserCount = data.userIds?._redacted === "USER_IDENTIFIER_LIST" ? numeric(data.userIds.count) : null;
    return {
      source_doc_id: documentId, address: data.address ?? null, block_number: numeric(data.blockNumber),
      created_at_utc: iso(data.createdAt), risk_level_legacy: data.riskLevel ?? null,
      risk_score_legacy: numeric(data.riskScore), total_usdt: numeric(data.totalUsdt),
      tx_count: numeric(data.txCount), tx_hash: data.txHash ?? null, event_type: data.type ?? null,
      user_count: userIds?.length ?? redactedUserCount,
      user_ids_json: userIds ? safeJson(userIds) : (redactedUserCount == null ? "" : "[REDACTED]"),
      extras_json: safeJson(withoutKeys(data, known)),
    };
  }
  if (collection === "feature_snapshots") {
    const known = new Set(["snapshotId", "address", "snapshotAtMs", "snapshotDay", "chain", "asset", "source", "objectId", "featureSetVersion", "features", "createdAt", "updatedAt"]);
    const features = data.features || {};
    const row = {
      source_doc_id: documentId, snapshot_id: data.snapshotId ?? documentId, address: data.address ?? null,
      snapshot_at_ms: toMillis(data.snapshotAtMs), snapshot_at_utc: iso(data.snapshotAtMs),
      snapshot_day: data.snapshotDay ?? null, chain: data.chain ?? null, asset: data.asset ?? null,
      source: data.source ?? null, object_id: data.objectId ?? null, feature_set_version: data.featureSetVersion ?? null,
      created_at_utc: iso(data.createdAt), updated_at_utc: iso(data.updatedAt), exported_at_utc: exportedAt,
      extras_json: safeJson(withoutKeys(data, known)),
    };
    for (const feature of FEATURE_NAMES) row[toSnake(feature)] = numeric(features[feature]);
    return row;
  }
  if (collection === "label_history") {
    const known = new Set(["labelId", "address", "chain", "source", "category", "publishedAtMs", "effectiveAtMs", "observedAtMs", "validFromMs", "validToMs", "labelConfidence", "evidenceRef", "revoked", "labelVersion", "createdAt", "updatedAt", "actor"]);
    return {
      source_doc_id: documentId, label_id: data.labelId ?? documentId, address: data.address ?? null,
      chain: data.chain ?? null, source: data.source ?? null, category: data.category ?? null,
      published_at_ms: toMillis(data.publishedAtMs), published_at_utc: iso(data.publishedAtMs),
      effective_at_ms: toMillis(data.effectiveAtMs), effective_at_utc: iso(data.effectiveAtMs),
      observed_at_ms: toMillis(data.observedAtMs), observed_at_utc: iso(data.observedAtMs),
      valid_from_ms: toMillis(data.validFromMs), valid_from_utc: iso(data.validFromMs),
      valid_to_ms: toMillis(data.validToMs), valid_to_utc: iso(data.validToMs),
      label_confidence: numeric(data.labelConfidence), evidence_ref: data.evidenceRef ?? null,
      revoked: Boolean(data.revoked), label_version: data.labelVersion ?? null,
      created_at_utc: iso(data.createdAt), updated_at_utc: iso(data.updatedAt), exported_at_utc: exportedAt,
      extras_json: safeJson(withoutKeys(data, known)),
    };
  }
  if (collection === "assessments") {
    const known = new Set(["txId", "timestamp", "chain", "monitorAddress", "from", "amount", "currency", "risk", "createdAt"]);
    return {
      source_doc_id: documentId, tx_id: data.txId ?? documentId, timestamp_utc: iso(data.timestamp),
      chain: data.chain ?? null, monitor_address: data.monitorAddress ?? null, from_address: data.from ?? null,
      amount: numeric(data.amount), currency: data.currency ?? null, risk_bucket: data.risk?.bucket ?? null,
      risk_score: numeric(data.risk?.score), risk_probability: numeric(data.risk?.probability),
      model_version: data.risk?.modelVersion ?? null, feature_set_version: data.risk?.featureSetVersion ?? null,
      ai_model_version: data.risk?.aiModelVersion ?? null, created_at_utc: iso(data.createdAt),
      exported_at_utc: exportedAt, extras_json: safeJson(withoutKeys(data, known)),
    };
  }
  const payload = data.payload || {};
  const known = new Set(["id", "addressAnalizado", "createdAt", "payload"]);
  return {
    source_doc_id: documentId, analysis_id: data.id ?? payload.id ?? documentId,
    address: data.addressAnalizado ?? payload.wallet?.address ?? null, created_at_utc: iso(data.createdAt),
    risk_level: payload.overview?.riskLevel ?? null, risk_score: numeric(payload.overview?.riskScore),
    model_version: payload.overview?.modelVersion ?? null, feature_set_version: payload.overview?.featureSetVersion ?? null,
    exported_at_utc: exportedAt, extras_json: safeJson(withoutKeys(data, known)),
  };
}

function recordTimestamp(collection, data) {
  const candidates = collection === "feature_snapshots" ? [data.snapshotAtMs, data.createdAt]
    : collection === "label_history" ? [data.observedAtMs, data.publishedAtMs, data.effectiveAtMs, data.createdAt]
      : collection === "assessments" ? [data.timestamp, data.createdAt] : [data.createdAt];
  for (const candidate of candidates) { const ms = toMillis(candidate); if (ms != null) return ms; }
  return null;
}

export function isInDateRange(collection, data, fromMs, toMs) {
  if (fromMs == null && toMs == null) return true;
  const ms = recordTimestamp(collection, data);
  if (ms == null) return false;
  return (fromMs == null || ms >= fromMs) && (toMs == null || ms <= toMs);
}

function inferType(value) {
  if (value == null) return "null";
  if (isTimestampLike(value) || value instanceof Date) return "timestamp";
  if (Array.isArray(value)) return "array";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "bytes";
  return typeof value === "object" ? "map" : typeof value;
}
function updateObservedFields(target, data) {
  for (const [key, value] of Object.entries(data || {})) {
    if (!target[key]) target[key] = { count: 0, types: new Set() };
    target[key].count += 1; target[key].types.add(inferType(value));
  }
}
async function writeLine(stream, line) { if (!stream.write(line)) await once(stream, "drain"); }
async function closeStream(stream) { stream.end(); await once(stream, "finish"); }
async function sha256File(filePath) {
  const hash = createHash("sha256"); const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk)); await once(stream, "end"); return hash.digest("hex");
}
async function fileMetadata(filePath, root) {
  const info = await stat(filePath);
  return { path: path.relative(root, filePath), sizeBytes: info.size, sha256: await sha256File(filePath) };
}
function defaultOutputDirectory() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return path.resolve(process.cwd(), "exports", `risk-data-${stamp}`);
}
async function ensureNewDirectory(directory) {
  const resolved = path.resolve(directory);
  const forbidden = new Set([path.parse(resolved).root, path.resolve(process.cwd()), path.resolve(process.env.HOME || "/nonexistent")]);
  if (forbidden.has(resolved)) throw new Error(`Directorio de salida inseguro: ${resolved}`);
  try { await mkdir(resolved, { recursive: false, mode: 0o700 }); }
  catch (error) {
    if (error?.code === "ENOENT") {
      await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
      await mkdir(resolved, { recursive: false, mode: 0o700 });
    } else if (error?.code === "EEXIST") throw new Error(`El directorio ya existe: ${resolved}. Use una ruta nueva.`);
    else throw error;
  }
  await mkdir(path.join(resolved, "raw"), { mode: 0o700 });
  await mkdir(path.join(resolved, "csv"), { mode: 0o700 });
  return resolved;
}
function initializeFirestore(options) {
  const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const appOptions = emulator ? { projectId: options.projectId } : { projectId: options.projectId, credential: applicationDefault() };
  const app = getApps()[0] || initializeApp(appOptions);
  return options.databaseId === "(default)" ? getFirestore(app) : getFirestore(app, options.databaseId);
}

async function exportCollection(db, collection, outputDirectory, options, exportedAt) {
  const rawPath = path.join(outputDirectory, "raw", `${collection}.ndjson`);
  const csvPath = path.join(outputDirectory, "csv", `${collection}.csv`);
  const rawStream = createWriteStream(rawPath, { encoding: "utf8", mode: 0o600, flags: "wx" });
  const csvStream = createWriteStream(csvPath, { encoding: "utf8", mode: 0o600, flags: "wx" });
  const headers = CSV_SCHEMAS[collection];
  await writeLine(csvStream, `${headers.map(csvEscape).join(",")}\n`);
  const observedFields = {};
  let scanned = 0; let exported = 0; let filteredByDate = 0; let cursor = null; let truncated = false;
  let minTimestampMs = null; let maxTimestampMs = null;
  try {
    while (true) {
      let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(options.pageSize);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      if (snapshot.empty) break;
      for (const doc of snapshot.docs) {
        scanned += 1;
        const original = doc.data(); updateObservedFields(observedFields, original);
        if (!isInDateRange(collection, original, options.fromMs, options.toMs)) { filteredByDate += 1; continue; }
        const normalized = normalizeFirestoreValue(original, options);
        const timestampMs = recordTimestamp(collection, original);
        if (timestampMs != null) {
          minTimestampMs = minTimestampMs == null ? timestampMs : Math.min(minTimestampMs, timestampMs);
          maxTimestampMs = maxTimestampMs == null ? timestampMs : Math.max(maxTimestampMs, timestampMs);
        }
        const envelope = { _collection: collection, _documentId: doc.id, _path: doc.ref.path,
          _exportSchemaVersion: EXPORT_SCHEMA_VERSION, _exportedAt: exportedAt, data: normalized };
        await writeLine(rawStream, `${JSON.stringify(envelope)}\n`);
        const csvRow = flattenForCsv(collection, doc.id, normalized, exportedAt);
        await writeLine(csvStream, `${headers.map((key) => csvEscape(csvRow[key])).join(",")}\n`);
        exported += 1;
        if (options.maxDocs != null && exported >= options.maxDocs) { truncated = true; break; }
      }
      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (truncated || snapshot.size < options.pageSize) break;
      process.stdout.write(`  ${collection}: ${exported} documentos exportados\r`);
    }
  } finally { await Promise.all([closeStream(rawStream), closeStream(csvStream)]); }
  process.stdout.write(`  ${collection}: ${exported} documentos exportados\n`);
  const fields = Object.fromEntries(Object.entries(observedFields).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, { count: value.count, types: [...value.types].sort() }]));
  return {
    collection, scanned, exported, filteredByDate, truncated,
    minTimestampUtc: minTimestampMs == null ? null : new Date(minTimestampMs).toISOString(),
    maxTimestampUtc: maxTimestampMs == null ? null : new Date(maxTimestampMs).toISOString(),
    observedFields: fields,
    files: [await fileMetadata(rawPath, outputDirectory), await fileMetadata(csvPath, outputDirectory)],
  };
}

export async function runExport(options) {
  const outputDirectory = await ensureNewDirectory(options.output || defaultOutputDirectory());
  const exportedAt = new Date().toISOString(); const db = initializeFirestore(options);
  const manifest = {
    exportSchemaVersion: EXPORT_SCHEMA_VERSION, status: "RUNNING", projectId: options.projectId,
    databaseId: options.databaseId, exportedAt, completedAt: null,
    filters: { fromUtc: options.fromMs == null ? null : new Date(options.fromMs).toISOString(),
      toUtc: options.toMs == null ? null : new Date(options.toMs).toISOString(), maxDocsPerCollection: options.maxDocs },
    privacy: { userIdentifiersIncluded: options.includeUserIdentifiers, secretsAlwaysRedacted: true,
      note: "Las direcciones blockchain se conservan para unir snapshots y etiquetas." },
    collections: [],
  };
  try {
    for (const collection of options.collections) {
      console.log(`Exportando ${collection}...`);
      manifest.collections.push(await exportCollection(db, collection, outputDirectory, options, exportedAt));
    }
    manifest.status = "COMPLETED"; manifest.completedAt = new Date().toISOString();
  } catch (error) {
    manifest.status = "FAILED"; manifest.completedAt = new Date().toISOString(); manifest.error = error?.message || String(error); throw error;
  } finally {
    const manifestPath = path.join(outputDirectory, "manifest.json");
    const handle = await open(manifestPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"); await handle.close();
  }
  return { outputDirectory, manifest };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); return; }
    console.log("Wallet Alert Risk AI — exportación Firestore de sólo lectura");
    console.log(`Proyecto: ${options.projectId} · Base: ${options.databaseId}`);
    console.log(`Colecciones: ${options.collections.join(", ")}`);
    if (!options.includeUserIdentifiers) console.log("Privacidad: identificadores de usuario redactados");
    const result = await runExport(options);
    console.log(`Exportación completada: ${result.outputDirectory}`);
    console.log("Comparta el directorio completo comprimido, incluido manifest.json.");
  } catch (error) { console.error(`ERROR: ${error?.message || error}`); process.exitCode = 1; }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
