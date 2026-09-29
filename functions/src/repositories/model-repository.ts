import admin from "firebase-admin";
import {OnchainShadowModel, TronSentinelModel} from "../risk/contracts";
import {ApiError} from "../middleware/errors";

const DEFAULT_CACHE_MS = 5 * 60 * 1000;

let cache: {model: TronSentinelModel | null; expiresAt: number} = {
  model: null,
  expiresAt: 0,
};
let shadowCache: {model: OnchainShadowModel | null; expiresAt: number} = {
  model: null,
  expiresAt: 0,
};

function cacheMs(): number {
  const parsed = Number(process.env.APP_MODEL_CACHE_MS || DEFAULT_CACHE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CACHE_MS;
}

export async function getShadowModel(
  db: admin.firestore.Firestore,
): Promise<OnchainShadowModel> {
  if (shadowCache.model && shadowCache.expiresAt > Date.now()) return shadowCache.model;
  const pointer = await db.collection("ts_model_control").doc("current").get();
  const modelVersion = String(pointer.data()?.shadowModelVersion || "").trim();
  if (!modelVersion) throw new ApiError(503, "SHADOW_MODEL_NOT_AVAILABLE", "No existe un modelo shadow configurado.");
  const document = await db.collection("ts_model_registry").doc(modelVersion).get();
  if (!document.exists) throw new ApiError(503, "SHADOW_MODEL_NOT_AVAILABLE", "El modelo shadow no está disponible.");
  const model = document.data() as OnchainShadowModel;
  if (model.status !== "CHALLENGER" || model.deploymentMode !== "SHADOW") {
    throw new ApiError(503, "SHADOW_MODEL_STATUS_INVALID", "El artefacto no está habilitado para modo shadow.");
  }
  shadowCache = {model, expiresAt: Date.now() + cacheMs()};
  return model;
}

export function publicShadowModel(model: OnchainShadowModel): object {
  return {
    modelVersion: model.modelVersion,
    artifactVersion: model.artifactVersion,
    status: model.status,
    deploymentMode: model.deploymentMode,
    featureSetVersion: model.featureSetVersion,
    labelVersion: model.labelVersion,
    lookbackDays: model.lookbackDays,
    productionProbabilityReady: model.productionProbabilityReady,
    scoreCalibration: {
      type: model.scoreCalibration.type,
      referencePopulation: model.scoreCalibration.referencePopulation,
      referenceSampleCount: model.scoreCalibration.referenceSampleCount,
      probabilityQuantiles: model.scoreCalibration.probabilityQuantiles,
      riskBands: model.scoreCalibration.riskBands,
      interpretation: model.scoreCalibration.interpretation,
    },
    shadowThreshold: model.shadowThreshold,
    metrics: model.metrics,
    governance: model.governance,
  };
}

export async function getChampionModel(
  db: admin.firestore.Firestore,
): Promise<TronSentinelModel> {
  if (cache.model && cache.expiresAt > Date.now()) return cache.model;

  const pointer = await db.collection("ts_model_control").doc("current").get();
  const modelVersion = String(pointer.data()?.championModelVersion || "").trim();
  if (!modelVersion) {
    throw new ApiError(503, "MODEL_NOT_AVAILABLE", "Todavía no existe un modelo campeón.");
  }

  const modelDocument = await db.collection("ts_model_registry").doc(modelVersion).get();
  if (!modelDocument.exists) {
    throw new ApiError(503, "MODEL_NOT_AVAILABLE", "El modelo campeón no está disponible.");
  }

  const model = modelDocument.data() as TronSentinelModel;
  if (model.status !== "CHAMPION") {
    throw new ApiError(503, "MODEL_NOT_CHAMPION", "El modelo configurado no está promovido.");
  }

  cache = {model, expiresAt: Date.now() + cacheMs()};
  return model;
}

export function publicModel(model: TronSentinelModel): object {
  return {
    modelVersion: model.modelVersion,
    status: model.status,
    algorithm: model.algorithm,
    featureSetVersion: model.featureSetVersion,
    labelVersion: model.labelVersion,
    horizonDays: model.horizonDays,
    thresholds: model.thresholds,
    metrics: model.metrics,
    trainedFrom: new Date(model.trainedFromMs).toISOString(),
    trainedTo: new Date(model.trainedToMs).toISOString(),
    createdAt: new Date(model.createdAtMs).toISOString(),
    datasetHash: model.datasetHash,
  };
}
