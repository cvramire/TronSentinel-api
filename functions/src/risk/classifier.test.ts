import assert from "node:assert/strict";
import test from "node:test";
import {predict, predictShadow} from "./classifier";
import {OnchainShadowModel, TronSentinelModel} from "./contracts";

const model: TronSentinelModel = {
  modelVersion: "test-1",
  status: "CHAMPION",
  algorithm: "gradient_boosted_stumps_v1",
  featureSetVersion: "features-test-1",
  labelVersion: "labels-test-1",
  horizonDays: 30,
  featureNames: ["txCount7d", "volume30d"],
  baseLogit: -2,
  learningRate: 1,
  stumps: [
    {feature: "txCount7d", threshold: 10, leftValue: -0.2, rightValue: 1.5},
    {feature: "volume30d", threshold: 1000, leftValue: -0.1, rightValue: 1.2},
  ],
  calibrator: {type: "platt", a: 1, b: 0},
  thresholds: {medium: 0.35, high: 0.65},
  metrics: {
    baseline: {
      prAuc: 0.1,
      recallHigh: 0.2,
      brier: 0.2,
      falsePositiveRate: 0.05,
      sampleCount: 100,
    },
    backtest: {
      prAuc: 0.3,
      recallHigh: 0.6,
      brier: 0.12,
      falsePositiveRate: 0.04,
      sampleCount: 30,
    },
  },
  trainedFromMs: 1,
  trainedToMs: 2,
  createdAtMs: 3,
  datasetHash: "test-hash",
};

test("el clasificador único incrementa el riesgo con señales mayores", () => {
  const low = predict(model, {txCount7d: 2, volume30d: 100});
  const high = predict(model, {txCount7d: 50, volume30d: 5000});

  assert.ok(high.probability > low.probability);
  assert.ok(high.score > low.score);
  assert.equal(high.riskLevel, "HIGH");
  assert.equal(low.riskLevel, "LOW");
});

test("rechaza vectores con variables faltantes", () => {
  assert.throws(
    () => predict(model, {txCount7d: 2}),
    /FEATURE_MISSING:volume30d/,
  );
});

test("rechaza variables que revelarían la etiqueta", () => {
  const leakingModel: TronSentinelModel = {
    ...model,
    featureNames: ["txCount7d", "blacklistExposure"],
  };

  assert.throws(
    () => predict(leakingModel, {txCount7d: 2, blacklistExposure: 1}),
    /LEAKAGE_FEATURE_FORBIDDEN:blacklistExposure/,
  );
});

test("mapea probabilidades raras a un score operativo de 0 a 100", () => {
  const rareEventModel: TronSentinelModel = {
    ...model,
    baseLogit: 0,
    stumps: [{feature: "txCount7d", threshold: 10, leftValue: -8.5, rightValue: -7}],
    thresholds: {medium: 0.0002, high: 0.0007},
    scoreMapping: {
      type: "risk_threshold_piecewise",
      mediumScore: 50,
      highScore: 80,
      capProbability: 0.002,
    },
  };
  const medium = predict(rareEventModel, {txCount7d: 2, volume30d: 1});
  const high = predict(rareEventModel, {txCount7d: 20, volume30d: 1});
  assert.ok(medium.score > 0 && medium.score < 80);
  assert.ok(high.score >= 80);
  assert.equal(high.riskLevel, "HIGH");
});

const shadowModel: OnchainShadowModel = {
  modelVersion: "shadow-model-1",
  artifactVersion: "shadow-artifact-1",
  status: "CHALLENGER",
  deploymentMode: "SHADOW",
  algorithm: "gradient_boosted_stumps_v1",
  featureSetVersion: "tron-wallet-onchain-1.0.0",
  labelVersion: "labels-v1",
  lookbackDays: 90,
  featureNames: ["outboundAmount"],
  baseLogit: -1,
  learningRate: 1,
  stumps: [{feature: "outboundAmount", threshold: 100, leftValue: -1, rightValue: 5}],
  calibrator: {type: "platt-case-control", a: 1, b: 0},
  productionProbabilityReady: false,
  scoreCalibration: {
    type: "empirical_control_percentile_v1",
    referencePopulation: "test-controls",
    referenceSampleCount: 100,
    referenceScores: Array.from({length: 100}, (_, index) => index / 100),
    probabilityQuantiles: {p50: 0.5, p80: 0.8, p95: 0.95},
    riskBands: {lowMax: 49, mediumMax: 79, highMax: 94},
    interpretation: "percentil de prueba",
  },
  shadowThreshold: {reviewProbability: 0.7, selection: "test"},
  metrics: {},
  governance: {shadowDeploymentAllowed: true},
};

test("calibra el challenger shadow como percentil de controles", () => {
  const low = predictShadow(shadowModel, {outboundAmount: 10});
  const high = predictShadow(shadowModel, {outboundAmount: 1000});
  assert.ok(high.sampleProbability > low.sampleProbability);
  assert.ok(high.riskScore > low.riskScore);
  assert.equal(high.riskLevel, "CRITICAL");
  assert.equal(high.reviewRecommended, true);
});

test("rechaza artefactos shadow promovidos indebidamente", () => {
  const invalid = {...shadowModel, deploymentMode: "PRODUCTION" as any};
  assert.throws(() => predictShadow(invalid, {outboundAmount: 1}), /SHADOW_MODEL_STATUS_INVALID/);
});
