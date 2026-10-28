"""Definición del modelo de TronSentinel.

El artefacto de producción es un ensamble de *gradient boosted stumps* (árboles de profundidad 1)
exportado a JSON (``baseLogit``, ``learningRate``, ``stumps``) más un calibrador Platt y un umbral
congelado. Este módulo:

* reproduce exactamente el cálculo del scorer TypeScript de la API (funciones ``raw_score`` y
  ``predict_proba`` sobre el JSON), y
* define :class:`TronSentinelModel`, el objeto que se guarda en ``models/best_model.pkl`` y que
  produce las mismas probabilidades que el JSON desplegado.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.ensemble import GradientBoostingClassifier

from src.data_processing import balanced_sample_weights
from src.utils import resolve_path

META_COLUMNS = ["cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target"]
REQUIRED_ARTIFACT_FIELDS = {"featureNames", "baseLogit", "learningRate", "stumps", "calibrator", "thresholds"}


def sigmoid(value):
    """Función logística con recorte numérico para evitar desbordamientos."""
    return 1.0 / (1.0 + np.exp(-np.clip(value, -40, 40)))


# --------------------------------------------------------------------------- artefacto JSON
def load_model(path: str | Path) -> dict:
    """Lee un artefacto JSON y valida que tenga la estructura esperada."""
    model = json.loads(resolve_path(path).read_text(encoding="utf-8"))
    missing = REQUIRED_ARTIFACT_FIELDS - set(model)
    if missing:
        raise ValueError(f"MODEL_MISSING_FIELDS:{','.join(sorted(missing))}")
    return model


def _check_features(names: list[str], features: pd.DataFrame) -> None:
    """Lanza ValueError si faltan columnas del modelo en el DataFrame (informa hasta 5)."""
    missing = [name for name in names if name not in features.columns]
    if missing:
        raise ValueError(f"FEATURES_MISSING:{','.join(missing[:5])}")


def raw_score(model: dict, features: pd.DataFrame) -> np.ndarray:
    """Suma de las contribuciones de los stumps (logit antes de calibrar)."""
    _check_features(model["featureNames"], features)
    raw = np.full(len(features), float(model["baseLogit"]), dtype=np.float64)
    rate = float(model["learningRate"])
    for stump in model["stumps"]:
        values = features[stump["feature"]].to_numpy(dtype=np.float64)
        raw += rate * np.where(values <= float(stump["threshold"]),
                               float(stump["leftValue"]), float(stump["rightValue"]))
    return raw


def predict_proba(model: dict, features: pd.DataFrame) -> np.ndarray:
    """Probabilidad de muestra case-control (no es un riesgo absoluto de producción)."""
    calibrator = model["calibrator"]
    return sigmoid(float(calibrator["a"]) * raw_score(model, features) + float(calibrator["b"]))


def threshold(model: dict) -> float:
    """Umbral operativo congelado (seleccionado en validación con FPR <= 5 %)."""
    return float(model["thresholds"]["candidateHighControlledFpr"])


def predict(model: dict, features: pd.DataFrame) -> np.ndarray:
    """Recomendación de revisión (1) o no (0) en el umbral congelado."""
    return (predict_proba(model, features) >= threshold(model)).astype(int)


def contributions(model: dict, features: pd.DataFrame) -> pd.DataFrame:
    """Contribución de cada variable al logit, por fila (misma lógica que la API).

    Para un stump la contribución es exacta: ``learningRate × valor de la hoja``. La suma de
    las contribuciones más ``baseLogit`` es igual a :func:`raw_score`.
    """
    _check_features(model["featureNames"], features)
    rate = float(model["learningRate"])
    result = pd.DataFrame(0.0, index=features.index, columns=model["featureNames"])
    for stump in model["stumps"]:
        values = features[stump["feature"]].to_numpy(dtype=np.float64)
        result[stump["feature"]] += rate * np.where(values <= float(stump["threshold"]),
                                                    float(stump["leftValue"]), float(stump["rightValue"]))
    return result


def stump_importance(model: dict) -> pd.Series:
    """Importancia por variable: suma de |hoja derecha − hoja izquierda| de sus stumps, normalizada."""
    gains: dict[str, float] = {}
    for stump in model["stumps"]:
        gains[stump["feature"]] = gains.get(stump["feature"], 0.0) + abs(stump["rightValue"] - stump["leftValue"])
    series = pd.Series(gains).sort_values(ascending=False)
    return series / series.sum()


# --------------------------------------------------------------------------- estimador
# Configuración del modelo desplegado v0.6.1 (stumps: el scorer de producción solo admite profundidad 1)
DEPLOYED_PARAMS = {
    "n_estimators": 150,
    "learning_rate": 0.04,
    "max_depth": 1,
    "min_samples_leaf": 20,
    "subsample": 0.8,
}
SEED = 20260927


class BalancedGradientBoosting(ClassifierMixin, BaseEstimator):
    """GradientBoostingClassifier con pesos balanceados por clase en cada ``fit``.

    Calcular los pesos dentro de ``fit`` hace que se respeten también dentro de la validación
    cruzada (cada pliegue usa sus propias proporciones).
    """

    def __init__(self, n_estimators=150, learning_rate=0.04, max_depth=1,
                 min_samples_leaf=20, subsample=0.8, random_state=SEED):
        """Guarda los hiperparámetros; los valores por defecto son los del modelo desplegado v0.6.1."""
        self.n_estimators = n_estimators
        self.learning_rate = learning_rate
        self.max_depth = max_depth
        self.min_samples_leaf = min_samples_leaf
        self.subsample = subsample
        self.random_state = random_state

    def fit(self, X, y):
        """Ajusta un GradientBoostingClassifier con pesos balanceados por clase y devuelve ``self``."""
        y = np.asarray(y, dtype=int)
        self.model_ = GradientBoostingClassifier(
            n_estimators=int(self.n_estimators), learning_rate=float(self.learning_rate),
            max_depth=int(self.max_depth), min_samples_leaf=int(self.min_samples_leaf),
            subsample=float(self.subsample), random_state=self.random_state,
        ).fit(X, y, sample_weight=balanced_sample_weights(y))
        self.classes_ = self.model_.classes_
        self.n_features_in_ = self.model_.n_features_in_
        return self

    def predict_proba(self, X):
        """Probabilidades por clase del modelo ajustado, sin calibrar (columnas: clase 0 y clase 1)."""
        return self.model_.predict_proba(X)

    def predict(self, X):
        """Clase predicha con el corte por defecto de scikit-learn (0,5), no con el umbral operativo congelado."""
        return self.model_.predict(X)

    @property
    def feature_importances_(self):
        """Importancia por variable del modelo ajustado según scikit-learn (suma 1)."""
        return self.model_.feature_importances_


# --------------------------------------------------------------------------- objeto serializable
@dataclass
class TronSentinelModel:
    """Clasificador entrenado + calibrador Platt + umbral congelado.

    ``estimator`` es un :class:`src.train.BalancedGradientBoosting` ya ajustado. El objeto se
    serializa con ``joblib`` en ``models/best_model.pkl`` y puede exportarse al formato JSON que
    consume la API con :meth:`to_artifact`.
    """

    estimator: object
    feature_names: list[str]
    calibrator_a: float
    calibrator_b: float
    review_threshold: float
    version: str = "local"
    metadata: dict = field(default_factory=dict)

    def raw_score(self, features: pd.DataFrame) -> np.ndarray:
        """Logit sin calibrar (``decision_function``) usando las variables de ``feature_names``, en ese orden."""
        _check_features(self.feature_names, features)
        return self.estimator.model_.decision_function(features[self.feature_names])

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        """Probabilidad calibrada (muestra case-control) de parecerse a una wallet riesgosa."""
        return sigmoid(self.calibrator_a * self.raw_score(features) + self.calibrator_b)

    def predict(self, features: pd.DataFrame) -> np.ndarray:
        """1 = se recomienda revisión humana; 0 = no se recomienda."""
        return (self.predict_proba(features) >= self.review_threshold).astype(int)

    def explain(self, features: pd.DataFrame, top: int = 5) -> list[list[tuple[str, float]]]:
        """Las ``top`` variables con mayor contribución absoluta para cada fila."""
        table = contributions(self.to_artifact(), features)
        return [sorted(row.items(), key=lambda item: abs(item[1]), reverse=True)[:top]
                for _, row in table.iterrows()]

    def to_artifact(self) -> dict:
        """Exporta el ensamble al formato JSON del scorer de la API (solo para profundidad 1)."""
        booster = self.estimator.model_
        if int(booster.max_depth) != 1:
            raise ValueError("EXPORT_REQUIRES_DEPTH_1: el scorer de producción solo admite stumps")
        stumps = []
        for tree in booster.estimators_[:, 0]:
            nodes = tree.tree_
            if nodes.node_count == 1:  # árbol sin división: aporta una constante
                value = float(nodes.value[0].ravel()[0])
                stumps.append({"feature": self.feature_names[0], "threshold": float("inf"),
                               "leftValue": value, "rightValue": value})
                continue
            stumps.append({
                "feature": self.feature_names[int(nodes.feature[0])],
                "threshold": float(nodes.threshold[0]),
                "leftValue": float(nodes.value[nodes.children_left[0]].ravel()[0]),
                "rightValue": float(nodes.value[nodes.children_right[0]].ravel()[0]),
            })
        base_logit = float(booster._raw_predict_init(np.zeros((1, len(self.feature_names))))[0, 0])
        return {
            "modelVersion": self.version,
            "algorithm": "gradient_boosted_stumps_v1",
            "featureNames": list(self.feature_names),
            "baseLogit": base_logit,
            "learningRate": float(booster.learning_rate),
            "stumps": stumps,
            "calibrator": {"type": "platt-case-control", "a": self.calibrator_a, "b": self.calibrator_b},
            "thresholds": {"candidateHighControlledFpr": self.review_threshold},
        }
