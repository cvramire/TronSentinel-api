"""Entrenamiento reproducible de TronSentinel.

Uso::

    python -m src.train                    # entrena, guarda models/*.pkl y verifica paridad
    python -m src.train --config otra.yaml

Pasos (idénticos a los usados para el modelo desplegado v0.6.1):

1. Gradient Boosting de stumps con pesos balanceados, ajustado **solo en train**.
2. Calibración Platt (regresión logística 1D sobre el logit) ajustada en **validación**.
3. Umbral = máximo F1 en validación sujeto a FPR <= 5 %.
4. Baseline: regresión logística sobre log(1+x) estandarizado (``models/model_v1.pkl``).

El test interno y el holdout externo **no se usan aquí**: ya fueron abiertos y quedan registrados
en ``governance/data-openings.json``; reutilizarlos para elegir parámetros sería fuga de información.
"""

from __future__ import annotations

import argparse

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import FunctionTransformer, StandardScaler

from src.data_processing import FEATURE_NAMES, get_split, load_dataset, log1p_clip, split_xy
from src.evaluate import classification_metrics
from src.model import (DEPLOYED_PARAMS, SEED, BalancedGradientBoosting, TronSentinelModel, load_model,
                       predict_proba)
from src.utils import get_logger, load_config, resolve_path, save_json, sha256_file

LOGGER = get_logger(__name__)
# Se reexportan para que los notebooks importen la configuración desplegada desde src.train.
__all__ = ["DEPLOYED_PARAMS", "SEED", "BalancedGradientBoosting", "fit_platt", "select_threshold",
           "build_baseline", "train", "verify_parity"]


def fit_platt(raw_scores, y) -> tuple[float, float]:
    """Calibración Platt: ``p = sigmoid(a · logit + b)`` ajustada por regresión logística 1D."""
    calibrator = LogisticRegression(C=1.0).fit(np.asarray(raw_scores).reshape(-1, 1), np.asarray(y, dtype=int))
    return float(calibrator.coef_[0, 0]), float(calibrator.intercept_[0])


def select_threshold(probabilities, y, max_fpr: float = 0.05) -> dict:
    """Umbral con mayor F1 cuyo FPR no supera ``max_fpr`` (se evalúa en validación)."""
    probabilities, y = np.asarray(probabilities, dtype=float), np.asarray(y, dtype=int)
    best = None
    for candidate in np.unique(probabilities)[::-1]:
        metrics = classification_metrics(y, probabilities, candidate)
        if metrics["fpr"] <= max_fpr and metrics["recall"] > 0 and (best is None or metrics["f1"] > best["f1"]):
            best = {"threshold": float(candidate), **metrics}
    if best is None:
        raise ValueError(f"Ningún umbral cumple FPR <= {max_fpr}")
    return best


def build_baseline():
    """Baseline lineal: log(1+x) → estandarización → regresión logística balanceada."""
    return make_pipeline(FunctionTransformer(log1p_clip), StandardScaler(),
                         LogisticRegression(max_iter=2000, class_weight="balanced"))


def train(config: dict) -> dict:
    """Entrena el modelo principal y el baseline; devuelve un resumen de validación."""
    seed = int(config["project"]["seed"])
    dataset = load_dataset(config["data"]["development"])
    X_train, y_train, _ = split_xy(get_split(dataset, "train"))
    X_val, y_val, _ = split_xy(get_split(dataset, "validation"))
    LOGGER.info("Train: %d filas (%d riesgosas) · Validación: %d filas (%d riesgosas)",
                len(y_train), y_train.sum(), len(y_val), y_val.sum())

    estimator = BalancedGradientBoosting(**config["model"]["params"], random_state=seed).fit(X_train, y_train)
    a, b = fit_platt(estimator.model_.decision_function(X_val), y_val)
    model = TronSentinelModel(estimator, list(FEATURE_NAMES), a, b, review_threshold=0.5,
                              version=config["model"]["version"])
    chosen = select_threshold(model.predict_proba(X_val), y_val, float(config["model"]["max_validation_fpr"]))
    model.review_threshold = chosen["threshold"]
    model.metadata = {"datasetSha256": sha256_file(config["data"]["development"]), "seed": seed,
                      "params": dict(config["model"]["params"])}

    baseline = build_baseline().fit(X_train, y_train)
    baseline_threshold = select_threshold(baseline.predict_proba(X_val)[:, 1], y_val,
                                          float(config["model"]["max_validation_fpr"]))

    joblib.dump(model, resolve_path(config["artifacts"]["best_model"]))
    joblib.dump({"pipeline": baseline, "threshold": baseline_threshold["threshold"],
                 "description": "Baseline v1: regresión logística sobre log1p estandarizado"},
                resolve_path(config["artifacts"]["baseline_model"]))
    LOGGER.info("Modelos guardados en %s y %s",
                config["artifacts"]["best_model"], config["artifacts"]["baseline_model"])

    summary = {
        "modelVersion": model.version,
        "calibrator": {"a": a, "b": b},
        "validation": {"gradientBoosting": chosen, "logisticBaseline": baseline_threshold},
        "parityWithDeployedArtifact": verify_parity(model, config, X_val),
    }
    save_json(summary, config["artifacts"]["train_summary"])
    return summary


def verify_parity(model: TronSentinelModel, config: dict, features) -> dict:
    """Compara el modelo recién entrenado con el JSON desplegado (deben coincidir exactamente)."""
    deployed_path = resolve_path(config["artifacts"]["deployed_json"])
    if not deployed_path.exists():
        return {"checked": False}
    deployed = load_model(deployed_path)
    difference = float(np.max(np.abs(model.predict_proba(features) - predict_proba(deployed, features))))
    same_threshold = abs(model.review_threshold - deployed["thresholds"]["candidateHighControlledFpr"]) < 1e-12
    LOGGER.info("Paridad con el artefacto desplegado: máx |Δp| = %.2e · mismo umbral: %s", difference, same_threshold)
    return {"checked": True, "maxAbsProbabilityDifference": difference, "sameThreshold": bool(same_threshold)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Entrena TronSentinel y guarda los modelos en models/")
    parser.add_argument("--config", default=None, help="Ruta a config.yaml (por defecto, la raíz del repo)")
    args = parser.parse_args()
    try:
        summary = train(load_config(args.config))
    except (FileNotFoundError, ValueError) as error:
        LOGGER.error("No se pudo entrenar: %s", error)
        raise SystemExit(1) from error
    gb = summary["validation"]["gradientBoosting"]
    print(f"Validación · umbral {gb['threshold']:.4f} · recall {gb['recall']:.3f} · FPR {gb['fpr']:.3f} "
          f"· PR-AUC {gb['auc_pr']:.3f} · paridad {summary['parityWithDeployedArtifact']}")


if __name__ == "__main__":
    main()
