"""Pruebas del modelo: paridad con producción, explicaciones y validación del artefacto."""

import json

import joblib
import numpy as np
import pytest

from src.data_processing import split_xy
from src.model import TronSentinelModel, contributions, load_model, predict, predict_proba, raw_score, threshold
from tests.conftest import ROOT

DEPLOYED = ROOT / "models/model_v0.6.1.json"


@pytest.fixture(scope="module")
def deployed():
    return load_model(DEPLOYED)


@pytest.fixture(scope="module")
def best_model():
    return joblib.load(ROOT / "models/best_model.pkl")


def test_umbral_congelado_y_probabilidades_validas(deployed, development):
    X, _, _ = split_xy(development)
    p = predict_proba(deployed, X)
    assert threshold(deployed) == pytest.approx(0.4288828973999436, abs=1e-15)
    assert np.all((p > 0) & (p < 1))
    assert set(np.unique(predict(deployed, X))) <= {0, 1}


def test_best_model_pkl_reproduce_el_artefacto_desplegado(deployed, best_model, development):
    X, _, _ = split_xy(development)
    assert isinstance(best_model, TronSentinelModel)
    assert np.max(np.abs(best_model.predict_proba(X) - predict_proba(deployed, X))) < 1e-12
    assert best_model.review_threshold == pytest.approx(threshold(deployed), abs=1e-12)


def test_exportacion_a_json_coincide_con_produccion(deployed, best_model):
    exported = best_model.to_artifact()
    assert exported["baseLogit"] == pytest.approx(deployed["baseLogit"], abs=1e-9)
    assert len(exported["stumps"]) == len(deployed["stumps"]) == 150
    for mine, theirs in zip(exported["stumps"], deployed["stumps"]):
        assert mine["feature"] == theirs["feature"]
        assert mine["threshold"] == pytest.approx(theirs["threshold"])
        assert mine["leftValue"] == pytest.approx(theirs["leftValue"])


def test_contribuciones_suman_el_logit(deployed, development):
    X, _, _ = split_xy(development.head(25))
    total = contributions(deployed, X).sum(axis=1).to_numpy() + deployed["baseLogit"]
    assert np.allclose(total, raw_score(deployed, X))


def test_metricas_de_validacion_reproducibles(deployed, development):
    from src.evaluate import classification_metrics
    X, y, _ = split_xy(development[development.datasetSplit == "validation"])
    metrics = classification_metrics(y, predict_proba(deployed, X), threshold(deployed))
    assert metrics["recall"] == pytest.approx(55 / 60)
    assert metrics["fpr"] == pytest.approx(9 / 218)


def test_artefacto_incompleto_o_variables_faltantes(tmp_path, deployed, development):
    broken = {k: v for k, v in deployed.items() if k != "calibrator"}
    path = tmp_path / "roto.json"
    path.write_text(json.dumps(broken))
    with pytest.raises(ValueError, match="MODEL_MISSING_FIELDS:calibrator"):
        load_model(path)
    X, _, _ = split_xy(development.head(3))
    with pytest.raises(ValueError, match="FEATURES_MISSING"):
        raw_score(deployed, X.drop(columns=["meanAmount"]))


def test_wilson_y_ppv():
    from src.evaluate import ppv_at_prevalence, wilson_interval
    p, low, high = wilson_interval(79, 99)
    assert p == pytest.approx(0.798, abs=1e-3) and 0.70 < low < p < high < 0.87
    assert ppv_at_prevalence(0.798, 0.037, 0.01) == pytest.approx(0.178, abs=2e-3)
