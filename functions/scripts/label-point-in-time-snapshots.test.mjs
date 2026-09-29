import assert from "node:assert/strict";
import test from "node:test";
import {classifySnapshot, normalizeEvidence} from "./label-point-in-time-snapshots.mjs";

const DAY_MS = 86_400_000;
const address = `T${"A".repeat(33)}`;
const at = Date.parse("2026-01-01T00:00:00Z");
const evidence = {
  address,
  chain: "tron-mainnet",
  category: "BLACKLIST",
  action: "ADD",
  dateBasis: "ONCHAIN_EVENT",
  effectiveAtUtc: "2026-02-01T00:00:00Z",
  observedAtUtc: "2026-02-02T00:00:00Z",
  source: "TRONSCAN_STABLECOIN_HISTORY",
  evidenceRef: "tx:abc",
  confidence: "0.99",
};

test("normaliza evidencia confirmada y fechada", () => {
  const normalized = normalizeEvidence(evidence);
  assert.equal(normalized.effectiveAtMs, Date.parse(evidence.effectiveAtUtc));
  assert.equal(normalized.confidence, 0.99);
});

test("rechaza pseudoetiquetas y fechas de observación imposibles", () => {
  assert.throws(() => normalizeEvidence({...evidence, legacy_risk_score: "80"}), /FORBIDDEN/);
  assert.throws(() => normalizeEvidence({...evidence, observedAtUtc: "2026-01-01T00:00:00Z"}), /OBSERVED_BEFORE/);
  assert.throws(() => normalizeEvidence({...evidence, dateBasis: "CURRENT_STATUS"}), /UNSUPPORTED_DATE_BASIS/);
});

test("marca positivo sólo cuando la inclusión ocurre después y dentro del horizonte", () => {
  const event = normalizeEvidence(evidence);
  assert.equal(classifySnapshot(at, [event], 90, at + 200 * DAY_MS).target, 1);
  assert.equal(classifySnapshot(at, [event], 15, at + 200 * DAY_MS).target, 0);
});

test("excluye snapshots posteriores a una inclusión conocida", () => {
  const event = normalizeEvidence(evidence);
  const result = classifySnapshot(Date.parse("2026-02-02T00:00:00Z"), [event], 90, at + 200 * DAY_MS);
  assert.equal(result.target, null);
  assert.equal(result.status, "EXCLUDED_ALREADY_LISTED");
});

test("censura negativos sin seguimiento completo", () => {
  const result = classifySnapshot(at, [], 90, at + 30 * DAY_MS);
  assert.equal(result.target, null);
  assert.equal(result.status, "CENSORED_INCOMPLETE_FOLLOWUP");
});
