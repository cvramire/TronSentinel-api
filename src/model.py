"""Carga y aplicación del modelo exportado de TronSentinel.

El artefacto de producción es un ensamble de *gradient boosted stumps* exportado a JSON
(``baseLogit``, ``learningRate``, ``stumps`` y un calibrador Platt). Este módulo reproduce
exactamente el cálculo del scorer TypeScript de la API para poder evaluarlo en Python.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

META_COLUMNS = ["cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target"]


def sigmoid(value):
    """Función logística con recorte numérico para evitar desbordamientos."""
    return 1.0 / (1.0 + np.exp(-np.clip(value, -40, 40)))


def load_model(path: str | Path) -> dict:
    """Lee un artefacto JSON y valida que tenga la estructura esperada."""
    model = json.loads(Path(path).read_text(encoding="utf-8"))
    required = {"featureNames", "baseLogit", "learningRate", "stumps", "calibrator", "thresholds"}
    missing = required - set(model)
    if missing:
        raise ValueError(f"MODEL_MISSING_FIELDS:{','.join(sorted(missing))}")
    return model


def raw_score(model: dict, features: pd.DataFrame) -> np.ndarray:
    """Suma de las contribuciones de los stumps (logit antes de calibrar)."""
    missing = [name for name in model["featureNames"] if name not in features.columns]
    if missing:
        raise ValueError(f"FEATURES_MISSING:{','.join(missing[:5])}")
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
