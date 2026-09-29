import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOnchainFeatures,
  isOnchainHistorySufficient,
  ONCHAIN_FEATURE_NAMES,
} from "./onchain-features";

const address = "TWxQHk8kcebGL8hGETKr9XaLhogtPYwgDx";
const counterpartyA = "TW9tA4QwM8Nqdw6tzji4bSorFfQQzHDdgp";
const counterpartyB = "TPhhpxsyNqc81xWXXKQH42GiT4AjY55yfH";
const day = 86_400_000;
const asOfMs = Date.parse("2026-06-05T00:00:00Z");

test("construye las 38 variables en vivo con la semántica de entrenamiento", () => {
  const result = buildOnchainFeatures({
    address,
    asOfMs,
    lookbackDays: 90,
    transfers: [
      {
        transactionId: "tx1", blockTimestamp: asOfMs - 3 * day,
        from: counterpartyA, to: address, valueRaw: "10000000",
        tokenAddress: "usdt", tokenSymbol: "USDT", tokenDecimals: 6, type: "Transfer",
      },
      {
        transactionId: "tx2", blockTimestamp: asOfMs - 2 * day,
        from: address, to: counterpartyB, valueRaw: "20000000",
        tokenAddress: "usdt", tokenSymbol: "USDT", tokenDecimals: 6, type: "Transfer",
      },
      {
        transactionId: "tx3", blockTimestamp: asOfMs - day,
        from: address, to: address, valueRaw: "5000000",
        tokenAddress: "tusd", tokenSymbol: "TUSD", tokenDecimals: 6, type: "Transfer",
      },
    ],
  });
  assert.equal(Object.keys(result.features).length, 38);
  assert.deepEqual(Object.keys(result.features), [...ONCHAIN_FEATURE_NAMES]);
  assert.equal(result.features.transferCount, 3);
  assert.equal(result.features.transactionCount, 3);
  assert.equal(result.features.inboundCount, 2);
  assert.equal(result.features.outboundCount, 2);
  assert.equal(result.features.totalAmount, 35);
  assert.equal(result.features.inboundAmount, 15);
  assert.equal(result.features.outboundAmount, 25);
  assert.equal(result.features.netFlowAmount, -10);
  assert.equal(result.features.selfTransferCount, 1);
  assert.equal(result.features.usdtTransferCount, 2);
  assert.equal(result.features.tusdTransferCount, 1);
  assert.equal(result.features.daysSinceLastTransfer, 1);
  assert.deepEqual(result.quality, {
    invalidAmountEvents: 0,
    clippedAmountEvents: 0,
    excludedNonTransferEvents: 0,
  });
});

test("una ventana completa sin actividad produce un vector finito", () => {
  const result = buildOnchainFeatures({address, asOfMs, lookbackDays: 90, transfers: []});
  for (const value of Object.values(result.features)) assert.equal(Number.isFinite(value), true);
  assert.equal(result.features.transferCount, 0);
  assert.equal(result.features.daysSinceLastTransfer, 90);
  assert.equal(isOnchainHistorySufficient([]), false);
});
