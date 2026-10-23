"""Configuración común de pytest: añade la raíz del repositorio al path e incluye datos de prueba."""

import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.data_processing import FEATURE_NAMES  # noqa: E402


@pytest.fixture(scope="session")
def development():
    """Dataset de desarrollo real (1 854 filas)."""
    return pd.read_csv(ROOT / "data/processed/development_dataset_v6.csv")


@pytest.fixture()
def tiny_frame():
    """Dataset sintético mínimo y válido: 2 grupos, cada uno con 1 caso y 1 control."""
    rows = []
    for group, split in [("g1", "train"), ("g2", "validation")]:
        for target in (1, 0):
            row = {name: float(target + 1) for name in FEATURE_NAMES}
            row.update({"cohortId": f"{group}-{target}", "matchedCaseId": group, "address": f"T{group}{target}",
                        "indexAtUtc": "2026-06-01T00:00:00.000Z", "datasetSplit": split, "target": target})
            rows.append(row)
    return pd.DataFrame(rows)
