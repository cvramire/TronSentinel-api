import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_NAMES,
  buildFeatureVector,
  parseCsvLine,
} from "./build-point-in-time-snapshots.mjs";

test("parsea campos CSV entre comillas", () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
});

test("el feature set no contiene campos de etiqueta o score anterior", () => {
  const joined = FEATURE_NAMES.join("|");
  assert.doesNotMatch(joined, /blacklist|ofac|tatum|risk.?score|risk.?level|label/i);
});

test("construye ratios seguros cuando no existen observaciones", () => {
  const empty = {
    snapshot: () => ({
      count: 0,
      uniqueTxCount: 0,
      activeDays: 0,
      amountSum: 0,
      amountMax: 0,
      amountAverage: 0,
      patternTxCountSum: 0,
      newWhaleCount: 0,
      accumulationCount: 0,
      distributionCount: 0,
    }),
  };
  const features = buildFeatureVector(1000, {timestampMs: 1000}, {
    one: empty,
    seven: empty,
    thirty: empty,
    ninety: empty,
  });
  assert.equal(features.eventsPerActiveDay30d, 0);
  assert.equal(features.recentToLongVolumeRatio, 0);
  assert.ok(Object.values(features).every(Number.isFinite));
});
