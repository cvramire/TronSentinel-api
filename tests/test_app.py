"""Pruebas de la aplicación local (Flask) con el cliente de pruebas."""

import io

import pandas as pd
import pytest

from app.app import create_app
from src.data_processing import FEATURE_NAMES
from tests.conftest import ROOT


@pytest.fixture(scope="module")
def client():
    app = create_app()
    app.testing = True
    return app.test_client()


@pytest.fixture(scope="module")
def risky_features():
    external = pd.read_csv(ROOT / "data/processed/external_holdout_v6.csv")
    row = external[external.target == 1].iloc[0]
    return {name: float(row[name]) for name in FEATURE_NAMES}


def test_sirve_la_interfaz_y_health(client):
    page = client.get("/")
    assert page.status_code == 200 and b"TronSentinel" in page.data
    assert client.get("/local").status_code == 200
    assert client.get("/health").get_json()["ok"] is True


def test_evalua_un_ejemplo_precargado(client):
    sample = client.get("/api/local/sample?kind=risk").get_json()
    response = client.post("/api/local/score", json={"features": sample["features"]})
    body = response.get_json()
    assert response.status_code == 200
    assert 0 < body["sampleProbability"] < 1
    assert body["deploymentMode"] == "SHADOW"
    assert len(body["contributions"]) == 5


@pytest.mark.parametrize("change, code", [
    (lambda f: f.pop("meanAmount"), "FEATURES_MISSING"),
    (lambda f: f.update(meanAmount="mucho"), "INVALID_VALUE"),
    (lambda f: f.update(transferCount=-1), "INVALID_VALUE"),
])
def test_valida_entradas(client, risky_features, change, code):
    features = dict(risky_features)
    change(features)
    response = client.post("/api/local/score", json={"features": features})
    assert response.status_code == 400 and response.get_json()["error"] == code


def test_rechaza_cuerpo_vacio_y_tipo_de_ejemplo(client):
    assert client.post("/api/local/score", json={}).get_json()["error"] == "INVALID_BODY"
    assert client.get("/api/local/sample?kind=otro").status_code == 400


def test_evalua_csv_de_ejemplo(client):
    data = (ROOT / "app/assets/ejemplo_wallets.csv").read_bytes()
    response = client.post("/api/local/score-csv", data={"file": (io.BytesIO(data), "ejemplo.csv")},
                           content_type="multipart/form-data")
    rows = response.get_json()["rows"]
    assert response.status_code == 200 and len(rows) == 10
    assert sum(r["reviewRecommended"] for r in rows if r["groundTruth"] == 1) >= 3


def test_csv_invalido(client):
    response = client.post("/api/local/score-csv", data={"file": (io.BytesIO(b"a,b\n1,2\n"), "x.csv")},
                           content_type="multipart/form-data")
    assert response.status_code == 400 and "Fila 1" in response.get_json()["message"]
