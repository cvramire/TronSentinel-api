import assert from "node:assert/strict";
import test from "node:test";
import { csvEscape, isInDateRange, normalizeFirestoreValue, parseArgs, toMillis } from "./export-risk-data.mjs";

test("redacta secretos e identificadores de usuario por defecto", () => {
  const normalized = normalizeFirestoreValue({ address: "T123", userIds: ["u1"], nested: { email: "test@example.com", privateKey: "secret-key" } });
  assert.equal(normalized.address, "T123");
  assert.deepEqual(normalized.userIds, { _redacted: "USER_IDENTIFIER_LIST", count: 1 });
  assert.equal(normalized.nested.email, "[REDACTED_USER_IDENTIFIER]");
  assert.equal(normalized.nested.privateKey, "[REDACTED_SECRET]");
});

test("permite identificadores sólo con opción explícita y nunca secretos", () => {
  const normalized = normalizeFirestoreValue({ userId: "u1", mnemonic: "words" }, { includeUserIdentifiers: true });
  assert.equal(normalized.userId, "u1");
  assert.equal(normalized.mnemonic, "[REDACTED_SECRET]");
});

test("convierte timestamps Firestore y fechas", () => {
  assert.equal(toMillis({ _seconds: 1_700_000_000, _nanoseconds: 500_000_000 }), 1_700_000_000_500);
  assert.equal(toMillis("2026-09-22T10:00:00Z"), Date.parse("2026-09-22T10:00:00Z"));
});

test("escapa CSV sin corromper comillas, comas o saltos", () => {
  assert.equal(csvEscape("simple"), "simple");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
});

test("filtra temporalmente usando el campo propio de cada colección", () => {
  const from = Date.parse("2026-01-01T00:00:00Z"); const to = Date.parse("2026-12-31T23:59:59Z");
  assert.equal(isInDateRange("feature_snapshots", { snapshotAtMs: Date.parse("2026-06-01T00:00:00Z") }, from, to), true);
  assert.equal(isInDateRange("label_history", { observedAtMs: Date.parse("2025-12-01T00:00:00Z") }, from, to), false);
  assert.equal(isInDateRange("intelligenceAlerts", {}, from, to), false);
});

test("valida colecciones, fechas y límites", () => {
  const options = parseArgs(["--include-audit", "--page-size", "250", "--from", "2026-01-01T00:00:00Z"]);
  assert.equal(options.pageSize, 250); assert.ok(options.collections.includes("assessments"));
  assert.throws(() => parseArgs(["--collections", "users"]), /Colección no permitida/);
  assert.throws(() => parseArgs(["--page-size", "0"]), /entero/);
});
