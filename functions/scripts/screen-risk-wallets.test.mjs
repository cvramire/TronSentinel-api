import assert from "node:assert/strict";
import test from "node:test";
import { buildMonthlyWindows, classifyBlacklistEventName, classifyTransactionEvents, consolidateResults, normalizeProviderResult, parseArgs, parseCsvLine, selectStratifiedSample, tronHexToBase58 } from "./screen-risk-wallets.mjs";

const address = (char) => `T${char.repeat(33)}`;

test("interpreta CSV con comas y comillas", () => {
  assert.deepEqual(parseCsvLine('T123,"texto, con coma","a""b"'), ["T123", "texto, con coma", 'a"b']);
});

test("valida comandos, proveedores y límites", () => {
  const parsed = parseArgs(["sample", "--input", "in.csv", "--output", "out.csv", "--critical", "10"]);
  assert.equal(parsed.counts.CRITICAL, 10);
  assert.throws(() => parseArgs(["screen", "--input", "in.csv", "--output", "out", "--providers", "otro"]), /sólo admite/);
  assert.throws(() => parseArgs(["blacklist-history", "--output", "out", "--page-size", "10"]), /entero/);
});

test("selecciona muestra determinística y respeta estratos", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ address: address(String(i + 1)), legacy_pseudo_risk_level: "CRITICAL", legacy_pseudo_risk_score_max: i < 4 ? "120" : "90" })),
    ...Array.from({ length: 5 }, (_, i) => ({ address: address(String.fromCharCode(65 + i)), legacy_pseudo_risk_level: "HIGH", legacy_pseudo_risk_score_max: "75" })),
  ];
  const counts = { CRITICAL: 4, HIGH: 2, MEDIUM: 0, LOW: 0 };
  const first = selectStratifiedSample(rows, counts, "seed");
  const second = selectStratifiedSample(rows, counts, "seed");
  assert.deepEqual(first.map((x) => x.address), second.map((x) => x.address));
  assert.equal(first.filter((x) => x.level === "CRITICAL").length, 4);
  assert.equal(first.filter((x) => x.level === "HIGH").length, 2);
  assert.equal(new Set(first.filter((x) => x.level === "CRITICAL").map((x) => x.score)).size, 2);
});

test("normaliza respuestas de Tatum y TRONSCAN", () => {
  const tatum = normalizeProviderResult("tatum", { status: "invalid", source: "Provider", description: "scam" });
  assert.equal(tatum.providerStatus, "FLAGGED");
  assert.equal(tatum.flags.maliciousReported, true);
  const tron = normalizeProviderResult("tronscan", { is_black_list: true, has_fraud_transaction: false, fraud_token_creator: false, send_ad_by_memo: false });
  assert.equal(tron.flags.isBlackList, true);
});

test("consolida positivos sin tratar los negativos como limpios permanentes", () => {
  const samples = [{ address: address("A"), legacy_risk_level: "HIGH", legacy_risk_score: "75" }];
  const results = [
    { address: address("A"), provider: "tronscan", ok: true, checkedAtUtc: "2026-09-22T00:00:00Z", providerStatus: "FLAGGED", flags: { isBlackList: true }, rawResponseSha256: "hash" },
    { address: address("A"), provider: "tatum", ok: true, checkedAtUtc: "2026-09-22T00:00:01Z", providerStatus: "NOT_FLAGGED_AT_CHECK_TIME", flags: { maliciousReported: false }, rawResponseSha256: "hash2" },
  ];
  const consolidated = consolidateResults(samples, results);
  assert.equal(consolidated.rows[0].consolidated_status, "BLACKLIST_CONFIRMED");
  assert.equal(consolidated.labels.length, 1);
  assert.equal(consolidated.labels[0].category, "BLACKLIST");
});

test("clasifica altas y bajas únicamente por el nombre del evento on-chain", () => {
  assert.equal(classifyBlacklistEventName("AddedBlackList"), "ADD");
  assert.equal(classifyBlacklistEventName("RemovedBlackList"), "REMOVE");
  assert.equal(classifyBlacklistEventName("DestroyedBlackFunds"), "UNKNOWN");
});

test("genera ventanas mensuales en segundos sin solaparlas", () => {
  const windows = buildMonthlyWindows(Date.parse("2025-12-15T00:00:00Z"), Date.parse("2026-02-02T00:00:00Z"));
  assert.deepEqual(windows.map((window) => window.key), ["2025-12", "2026-01", "2026-02"]);
  assert.equal(windows[0].endSeconds + 1, windows[1].startSeconds);
});

test("convierte la dirección hexadecimal de un evento TRON a Base58Check", () => {
  assert.equal(tronHexToBase58("0x8d33a3ab9b4743eeffd5ae713acd857d487ce28f"), "TNqp955aR9FsWNC9zTZdvXg9MCQVWYWbKZ");
});

test("clasifica el evento exacto y valida la wallet afectada", () => {
  const events = [{
    transaction_id: "a".repeat(64), event_name: "AddedBlackList",
    contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    result: {_user: "0x8d33a3ab9b4743eeffd5ae713acd857d487ce28f"},
  }];
  assert.equal(classifyTransactionEvents(events, "TNqp955aR9FsWNC9zTZdvXg9MCQVWYWbKZ", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").action, "ADD");
  assert.equal(classifyTransactionEvents(events, address("B"), "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), null);
});

test("clasifica el evento Blacklisted de TUSD usando el valor booleano", () => {
  const base = {
    transaction_id: "0".repeat(64),
    contract_address: "TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4",
    event_name: "Blacklisted",
    result: {
      0: "0x667c201a950c64f00bac41facdd7bb386d7970d5",
      account: "0x667c201a950c64f00bac41facdd7bb386d7970d5",
      1: "true",
      isBlacklisted: "true",
    },
  };
  assert.equal(classifyTransactionEvents([base], "TKK6d1YALy8HCSoCSWWd1ZJhyC9NPPx4wa", base.contract_address).action, "ADD");
  const removed = {...base, result: {...base.result, 1: "false", isBlacklisted: "false"}};
  assert.equal(classifyTransactionEvents([removed], "TKK6d1YALy8HCSoCSWWd1ZJhyC9NPPx4wa", base.contract_address).action, "REMOVE");
});
