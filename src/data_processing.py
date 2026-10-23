"""Carga, validación y preparación del dataset on-chain de TronSentinel.

Cada fila es una wallet evaluada en una fecha índice (``indexAtUtc``) con 38 variables
calculadas sobre sus transferencias USDT/TUSD de los 90 días previos. Los casos (``target=1``)
fueron incluidos después en la blacklist de Tether; los controles (``target=0``) son wallets
activas en la misma fecha. Cada caso y sus controles comparten ``matchedCaseId``.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from src.utils import get_logger, resolve_path

LOGGER = get_logger(__name__)

META_COLUMNS = ["cohortId", "matchedCaseId", "address", "indexAtUtc", "datasetSplit", "target"]
VALID_SPLITS = {"train", "validation", "test", "external_holdout"}

# Palabras prohibidas en nombres de variables: la etiqueta nunca puede entrar como predictor.
FORBIDDEN_FEATURE_TERMS = ("blacklist", "label", "riskscore", "risklevel", "ofac", "tatum", "target")

FEATURE_FAMILIES = {
    "Actividad": ["transferCount", "transactionCount", "activeDays", "activeDayRatio", "averageDailyTransfers"],
    "Dirección del flujo": ["inboundCount", "outboundCount", "inboundRatio", "outboundRatio"],
    "Montos": ["totalAmount", "inboundAmount", "outboundAmount", "netFlowAmount", "meanAmount",
               "amountStd", "amountCv", "maxAmount"],
    "Contrapartes": ["uniqueCounterparties", "uniqueInboundCounterparties", "uniqueOutboundCounterparties",
                     "repeatedCounterpartyRatio"],
    "Concentración": ["topCounterpartyShare", "counterpartyHhi", "counterpartyEntropy",
                      "inboundTopCounterpartyShare", "outboundTopCounterpartyShare"],
    "Autotransferencias": ["selfTransferCount", "selfTransferRatio"],
    "Activos": ["usdtTransferCount", "tusdTransferCount", "usdtAmount", "tusdAmount"],
    "Temporalidad": ["meanInterEventSeconds", "interEventStdSeconds", "interEventCv", "burstiness",
                     "observedSpanDays", "daysSinceLastTransfer"],
}
FEATURE_NAMES = [name for family in FEATURE_FAMILIES.values() for name in family]
# Variables que pueden ser negativas por definición (flujo neto; burstiness ∈ [-1, 1]).
SIGNED_FEATURES = {"netFlowAmount", "burstiness"}


class DataValidationError(ValueError):
    """Error con la lista de problemas encontrados al validar un dataset."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("Dataset inválido: " + "; ".join(problems))


def load_dataset(path: str | Path, validate: bool = True) -> pd.DataFrame:
    """Lee un CSV del proyecto y, por defecto, lo valida antes de devolverlo."""
    csv_path = resolve_path(path)
    if not csv_path.exists():
        raise FileNotFoundError(f"No existe el dataset {csv_path}. Revisa data/README.md.")
    frame = pd.read_csv(csv_path)
    LOGGER.info("Dataset %s: %d filas, %d columnas", csv_path.name, len(frame), frame.shape[1])
    if validate:
        validate_dataset(frame)
    return frame


def validate_dataset(frame: pd.DataFrame, features: list[str] | None = None) -> dict:
    """Comprueba esquema, etiquetas, valores finitos, fuga de etiquetas y separación de grupos.

    Devuelve un resumen si todo está bien; si no, lanza :class:`DataValidationError`.
    """
    features = features or FEATURE_NAMES
    problems: list[str] = []
    missing = [column for column in META_COLUMNS + features if column not in frame.columns]
    if missing:
        raise DataValidationError([f"faltan columnas: {', '.join(missing[:8])}"])

    extra = [column for column in frame.columns if column not in META_COLUMNS and column not in features]
    leaking = [column for column in features + extra
               if any(term in column.lower() for term in FORBIDDEN_FEATURE_TERMS)]
    if leaking:
        problems.append(f"variables prohibidas (fuga de etiqueta): {', '.join(leaking)}")
    if not frame["target"].isin([0, 1]).all():
        problems.append("target debe ser 0 o 1")
    unknown_splits = set(frame["datasetSplit"].unique()) - VALID_SPLITS
    if unknown_splits:
        problems.append(f"particiones desconocidas: {', '.join(sorted(map(str, unknown_splits)))}")

    values = frame[features].to_numpy(dtype=float)
    non_finite = int((~np.isfinite(values)).sum())
    if non_finite:
        problems.append(f"{non_finite} valores faltantes o infinitos en las variables")
    negative = [name for name in features if name not in SIGNED_FEATURES and (frame[name] < 0).any()]
    if negative:
        problems.append(f"valores negativos inesperados en: {', '.join(negative[:5])}")

    shared_groups = groups_crossing_splits(frame)
    if shared_groups:
        problems.append(f"{len(shared_groups)} grupos matchedCaseId aparecen en más de una partición")
    duplicated = frame.duplicated(["address", "indexAtUtc"]).sum()
    if duplicated:
        problems.append(f"{duplicated} filas duplicadas (misma wallet y fecha índice)")

    if problems:
        raise DataValidationError(problems)
    return {
        "rows": int(len(frame)),
        "positives": int(frame["target"].sum()),
        "controls": int((frame["target"] == 0).sum()),
        "groups": int(frame["matchedCaseId"].nunique()),
        "splits": frame["datasetSplit"].value_counts().to_dict(),
    }


def groups_crossing_splits(frame: pd.DataFrame) -> list[str]:
    """Grupos emparejados presentes en más de una partición (debe ser una lista vacía)."""
    per_group = frame.groupby("matchedCaseId")["datasetSplit"].nunique()
    return per_group[per_group > 1].index.tolist()


def address_overlap(first: pd.DataFrame, second: pd.DataFrame) -> set[str]:
    """Direcciones compartidas entre dos datasets (el holdout externo no debe compartir ninguna)."""
    return set(first["address"]) & set(second["address"])


def get_split(frame: pd.DataFrame, split: str) -> pd.DataFrame:
    """Filtra una partición por nombre, con error explícito si no existe."""
    if split not in VALID_SPLITS:
        raise ValueError(f"Partición desconocida '{split}'. Opciones: {sorted(VALID_SPLITS)}")
    subset = frame[frame["datasetSplit"] == split]
    if subset.empty:
        raise ValueError(f"La partición '{split}' no tiene filas en este dataset")
    return subset


def split_xy(frame: pd.DataFrame, features: list[str] | None = None):
    """Separa variables, etiqueta y grupo emparejado."""
    features = features or FEATURE_NAMES
    return frame[features], frame["target"].to_numpy(dtype=int), frame["matchedCaseId"].to_numpy()


def log1p_clip(values):
    """Transformación log(1 + x) con recorte en 0; reduce la asimetría extrema de montos y conteos.

    Solo la usan el baseline lineal y el EDA: los árboles son invariantes a transformaciones monótonas.
    """
    return np.log1p(np.clip(np.asarray(values, dtype=float), 0, None))


def balanced_sample_weights(y) -> np.ndarray:
    """Pesos que igualan la contribución total de cada clase (n / (2 · n_clase))."""
    y = np.asarray(y, dtype=int)
    positives, controls = int(y.sum()), int(len(y) - y.sum())
    if positives == 0 or controls == 0:
        raise ValueError("Se necesitan ambas clases para calcular pesos balanceados")
    return np.where(y == 1, len(y) / (2 * positives), len(y) / (2 * controls))


def describe_by_class(frame: pd.DataFrame, features: list[str] | None = None) -> pd.DataFrame:
    """Medianas por clase y razón caso/control, útil para el EDA."""
    features = features or FEATURE_NAMES
    medians = frame.groupby("target")[features].median().T
    medians.columns = ["mediana_control", "mediana_caso"]
    medians["razon_caso_control"] = (medians["mediana_caso"] + 1e-9) / (medians["mediana_control"] + 1e-9)
    return medians


def volume_band(frame: pd.DataFrame, cutoff: float | None = None) -> np.ndarray:
    """Clasifica cada wallet en bajo o alto volumen según la mediana de ``totalAmount``."""
    cutoff = float(frame["totalAmount"].median()) if cutoff is None else cutoff
    return np.where(frame["totalAmount"] <= cutoff, "bajo volumen", "alto volumen")
