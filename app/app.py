"""Aplicación local de TronSentinel (Flask).

La interfaz oficial está desplegada en Firebase Hosting (https://pry-tronsentinel.web.app) y usa la
API en Cloud Functions, que consulta TronGrid en vivo. Esta aplicación permite usar el proyecto
en local sin Firebase:

* ``/``            sirve la misma interfaz HTML desplegada (``front/``), que llama a la API en la nube.
* ``/local``       evaluador offline: carga un CSV con las 38 variables y lo puntúa con el artefacto
                   desplegado (``models/model_v0.6.1.json``), sin red ni clave.
* ``/api/local/*`` endpoints JSON del evaluador offline.

Ejecutar desde la raíz del repositorio::

    python app/app.py            # http://127.0.0.1:8080
"""

from __future__ import annotations

import io
import math
import sys
from pathlib import Path

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.data_processing import FEATURE_NAMES, SIGNED_FEATURES  # noqa: E402
from src.model import contributions, load_model, predict_proba, threshold  # noqa: E402
from src.utils import get_logger, load_config, resolve_path  # noqa: E402

LOGGER = get_logger("tronsentinel.app")
ASSETS = Path(__file__).resolve().parent / "assets"
FRONT = ROOT / "front"
MAX_CSV_ROWS = 5000
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


class InputError(ValueError):
    """Error de validación con código estable para la interfaz."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def validate_features(payload: dict) -> pd.DataFrame:
    """Convierte un diccionario con las 38 variables en un DataFrame de una fila, validando cada valor."""
    if not isinstance(payload, dict):
        raise InputError("INVALID_BODY", "Se esperaba un objeto JSON con la clave 'features'.")
    missing = [name for name in FEATURE_NAMES if name not in payload]
    if missing:
        raise InputError("FEATURES_MISSING", f"Faltan {len(missing)} variables, por ejemplo: {', '.join(missing[:3])}.")
    row = {}
    for name in FEATURE_NAMES:
        try:
            value = float(payload[name])
        except (TypeError, ValueError):
            raise InputError("INVALID_VALUE", f"La variable {name} debe ser numérica.") from None
        if not math.isfinite(value):
            raise InputError("INVALID_VALUE", f"La variable {name} no puede ser infinita ni vacía.")
        if value < 0 and name not in SIGNED_FEATURES:
            raise InputError("INVALID_VALUE", f"La variable {name} no puede ser negativa.")
        row[name] = value
    return pd.DataFrame([row])


def score_frame(model: dict, features: pd.DataFrame) -> list[dict]:
    """Probabilidad muestral, decisión y las 5 contribuciones principales por fila."""
    probabilities = predict_proba(model, features)
    table = contributions(model, features)
    cut = threshold(model)
    results = []
    for position, probability in enumerate(probabilities):
        row = table.iloc[position]
        top = row.reindex(row.abs().sort_values(ascending=False).index[:5])
        results.append({
            "sampleProbability": float(probability),
            "reviewThreshold": cut,
            "reviewRecommended": bool(probability >= cut),
            "contributions": [{"feature": name, "contribution": float(value)} for name, value in top.items()],
        })
    return results


def create_app(config_path: str | None = None) -> Flask:
    """Fábrica de la aplicación (facilita las pruebas con ``app.test_client()``)."""
    config = load_config(config_path)
    model = load_model(config["artifacts"]["deployed_json"])
    samples = pd.read_csv(resolve_path(config["data"]["external_holdout"]))
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

    @app.errorhandler(InputError)
    def handle_input_error(error: InputError):
        return jsonify({"error": error.code, "message": error.message}), error.status

    @app.errorhandler(413)
    def handle_too_large(_error):
        return jsonify({"error": "FILE_TOO_LARGE", "message": "El archivo supera 5 MB."}), 413

    @app.get("/")
    def index():
        return send_from_directory(FRONT, "evaluador-wallet-tronsentinel.html")

    @app.get("/local")
    def local_page():
        return send_from_directory(ASSETS, "local.html")

    @app.get("/assets/<path:name>")
    def assets(name: str):
        return send_from_directory(ASSETS, name)

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "service": "tronsentinel-local", "modelVersion": model.get("modelVersion")})

    @app.get("/api/local/model")
    def model_info():
        return jsonify({
            "modelVersion": model.get("modelVersion"),
            "featureNames": model["featureNames"],
            "reviewThreshold": threshold(model),
            "lookbackDays": config["data"]["lookback_days"],
            "probabilityInterpretation": "CASE_CONTROL_SAMPLE_NOT_PRODUCTION_PROBABILITY",
            "deploymentMode": "SHADOW",
        })

    @app.get("/api/local/sample")
    def sample():
        kind = request.args.get("kind", "risk")
        if kind not in {"risk", "control"}:
            raise InputError("INVALID_KIND", "kind debe ser 'risk' o 'control'.")
        subset = samples[samples["target"] == (1 if kind == "risk" else 0)]
        row = subset.iloc[int(request.args.get("index", 0)) % len(subset)]
        return jsonify({"address": row["address"], "asOf": row["indexAtUtc"], "groundTruth": int(row["target"]),
                        "features": {name: float(row[name]) for name in FEATURE_NAMES}})

    @app.post("/api/local/score")
    def score():
        body = request.get_json(silent=True)
        if not body or "features" not in body:
            raise InputError("INVALID_BODY", "Envía un JSON con la forma {\"features\": {...38 variables...}}.")
        result = score_frame(model, validate_features(body["features"]))[0]
        LOGGER.info("Evaluación local: p=%.4f revisión=%s", result["sampleProbability"], result["reviewRecommended"])
        return jsonify({**result, "modelVersion": model.get("modelVersion"), "deploymentMode": "SHADOW"})

    @app.post("/api/local/score-csv")
    def score_csv():
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            raise InputError("FILE_REQUIRED", "Adjunta un archivo CSV en el campo 'file'.")
        try:
            frame = pd.read_csv(io.BytesIO(upload.read()))
        except (pd.errors.ParserError, UnicodeDecodeError, pd.errors.EmptyDataError):
            raise InputError("INVALID_CSV", "No se pudo leer el archivo como CSV.") from None
        if len(frame) == 0 or len(frame) > MAX_CSV_ROWS:
            raise InputError("INVALID_ROWS", f"El CSV debe tener entre 1 y {MAX_CSV_ROWS} filas.")
        rows = []
        for number, record in enumerate(frame.to_dict(orient="records"), start=1):
            try:
                rows.append(validate_features(record))
            except InputError as error:
                raise InputError(error.code, f"Fila {number}: {error.message}") from None
        results = score_frame(model, pd.concat(rows, ignore_index=True))
        if "address" in frame:
            identifiers = frame["address"].astype(str).tolist()
        else:
            identifiers = [f"fila {i + 1}" for i in range(len(frame))]
        truth = frame["target"].tolist() if "target" in frame else [None] * len(frame)
        return jsonify({"rows": [{"id": ident, "groundTruth": None if pd.isna(t) else int(t), **res}
                                 for ident, t, res in zip(identifiers, truth, results)]})

    return app


if __name__ == "__main__":
    settings = load_config()["app"]
    create_app().run(host=settings["host"], port=int(settings["port"]), debug=False)
