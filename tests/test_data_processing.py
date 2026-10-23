"""Pruebas del procesamiento y la validación de datos."""

import numpy as np
import pytest

from src.data_processing import (FEATURE_NAMES, DataValidationError, address_overlap, balanced_sample_weights,
                                 get_split, groups_crossing_splits, log1p_clip, split_xy, validate_dataset)


def test_el_dataset_real_es_valido_y_tiene_38_variables(development):
    summary = validate_dataset(development)
    assert len(FEATURE_NAMES) == 38
    assert summary["rows"] == 1854 and summary["positives"] == 400
    assert summary["splits"] == {"train": 1294, "test": 282, "validation": 278}


def test_ningun_grupo_emparejado_cruza_particiones(development):
    assert groups_crossing_splits(development) == []


def test_detecta_grupo_en_dos_particiones(tiny_frame):
    tiny_frame.loc[tiny_frame.index[-1], "matchedCaseId"] = "g1"
    with pytest.raises(DataValidationError, match="más de una partición"):
        validate_dataset(tiny_frame)


def test_rechaza_variables_con_fuga_de_etiqueta(tiny_frame):
    tiny_frame["blacklistFlag"] = 1
    with pytest.raises(DataValidationError, match="fuga de etiqueta"):
        validate_dataset(tiny_frame)


def test_rechaza_valores_faltantes_y_negativos(tiny_frame):
    tiny_frame.loc[0, "meanAmount"] = np.nan
    tiny_frame.loc[1, "transferCount"] = -3
    with pytest.raises(DataValidationError) as error:
        validate_dataset(tiny_frame)
    assert any("faltantes" in p for p in error.value.problems)
    assert any("negativos" in p for p in error.value.problems)


def test_split_xy_y_particion_inexistente(tiny_frame):
    X, y, groups = split_xy(get_split(tiny_frame, "train"))
    assert X.shape == (2, 38) and list(y) == [1, 0] and set(groups) == {"g1"}
    with pytest.raises(ValueError, match="no tiene filas"):
        get_split(tiny_frame, "test")
    with pytest.raises(ValueError, match="desconocida"):
        get_split(tiny_frame, "produccion")


def test_log1p_recorta_negativos_y_pesos_balanceados():
    assert np.allclose(log1p_clip([-5, 0, np.e - 1]), [0, 0, 1])
    weights = balanced_sample_weights([1, 0, 0, 0])
    assert weights[0] * 1 == pytest.approx(weights[1:].sum())   # misma masa total por clase
    with pytest.raises(ValueError):
        balanced_sample_weights([0, 0])


def test_holdout_externo_no_comparte_wallets_con_desarrollo(development):
    import pandas as pd
    from tests.conftest import ROOT
    external = pd.read_csv(ROOT / "data/processed/external_holdout_v6.csv")
    assert address_overlap(development, external) == set()
