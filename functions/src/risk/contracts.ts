export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type ShadowRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FeatureVector = Record<string, number>;

export interface ModelStump {
  feature: string;
  threshold: number;
  leftValue: number;
  rightValue: number;
}

export interface ModelMetrics {
  prAuc: number;
  recallHigh: number;
  precisionHigh?: number;
  brier: number;
  falsePositiveRate: number;
  sampleCount: number;
}

export interface TronSentinelModel {
  modelVersion: string;
  status: "CHALLENGER" | "CHAMPION" | "ARCHIVED";
  algorithm: "gradient_boosted_stumps_v1";
  featureSetVersion: string;
  labelVersion: string;
  horizonDays: number;
  featureNames: string[];
  baseLogit: number;
  learningRate: number;
  stumps: ModelStump[];
  calibrator: {
    type: "platt";
    a: number;
    b: number;
  };
  thresholds: {
    medium: number;
    high: number;
  };
  scoreMapping?: {
    type: "risk_threshold_piecewise";
    mediumScore: number;
    highScore: number;
    capProbability: number;
  };
  metrics: {
    baseline: ModelMetrics;
    backtest: ModelMetrics;
  };
  trainedFromMs: number;
  trainedToMs: number;
  createdAtMs: number;
  datasetHash: string;
}

export interface FeatureSnapshot {
  snapshotId: string;
  address: string;
  snapshotAtMs: number;
  featureSetVersion: string;
  features: FeatureVector;
}

export interface ClassifierResult {
  probability: number;
  score: number;
  riskLevel: RiskLevel;
  contributions: Array<{
    feature: string;
    contribution: number;
  }>;
}

export interface EntityScore extends ClassifierResult {
  address: string;
  asOf: string;
  snapshotAt: string;
  modelVersion: string;
  featureSetVersion: string;
  labelVersion: string;
  predictionHorizonDays: number;
}

export interface OnchainShadowModel {
  modelVersion: string;
  artifactVersion: string;
  status: "CHALLENGER";
  deploymentMode: "SHADOW";
  algorithm: "gradient_boosted_stumps_v1";
  featureSetVersion: string;
  labelVersion: string;
  lookbackDays: number;
  featureNames: string[];
  baseLogit: number;
  learningRate: number;
  stumps: ModelStump[];
  calibrator: {type: "platt-case-control"; a: number; b: number};
  productionProbabilityReady: false;
  scoreCalibration: {
    type: "empirical_control_percentile_v1";
    referencePopulation: string;
    referenceSampleCount: number;
    referenceScores: number[];
    probabilityQuantiles: Record<string, number>;
    riskBands: {lowMax: number; mediumMax: number; highMax: number};
    interpretation: string;
  };
  shadowThreshold: {reviewProbability: number; selection: string};
  metrics: Record<string, unknown>;
  governance: Record<string, unknown> & {shadowDeploymentAllowed: boolean};
}

export interface ShadowClassifierResult {
  sampleProbability: number;
  riskScore: number;
  riskLevel: ShadowRiskLevel;
  reviewRecommended: boolean;
  contributions: Array<{feature: string; contribution: number}>;
}
