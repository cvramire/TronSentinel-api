#!/usr/bin/env python3
"""Utilidades compartidas de evaluación y gobernanza para los modelos on-chain.

Este módulo concentra las reglas que deben aplicarse de forma idéntica en
entrenamiento, diagnóstico y confirmación:

- línea base nula de PR-AUC igual a la prevalencia de la partición;
- bootstrap agrupado por ``matchedCaseId`` con diferencias pareadas;
- regla externa y predefinida de early stopping sobre validación;
- calendario determinista de semillas;
- registro (ledger) de particiones ya abiertas, para impedir reutilizarlas
  en selección de modelos.

No contiene ningún parámetro del modelo desplegado ni lo modifica.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score


# ---------------------------------------------------------------------------
# Constantes de política
# ---------------------------------------------------------------------------

ACADEMIC_SEED_COUNT = 30
QUICK_SEED_COUNT = 10
SEED_STEP = 104729

DEFAULT_ESTIMATOR_GRID = (150, 300, 500, 700, 900, 1000)
DEFAULT_MAX_ESTIMATORS = 1000
DEFAULT_EARLY_STOPPING_PATIENCE = 50
DEFAULT_EARLY_STOPPING_MIN_DELTA = 1e-4

# Mejora absoluta mínima que el límite inferior del IC 95 % de PR-AUC debe
# superar sobre la prevalencia para considerar que existe aprendizaje material.
DEFAULT_MIN_PR_AUC_LIFT = 0.10

DEFAULT_BOOTSTRAP_REPETITIONS = 2000
ACADEMIC_BOOTSTRAP_REPETITIONS = 5000

LEDGER_PARTITIONS = ("internal-test", "external-holdout")


@dataclass(frozen=True)
class RegularizationExperiment:
    key: str
    name: str
    max_depth: int
    min_samples_leaf: int
    subsample: float

    @property
    def stochastic(self) -> bool:
        return self.subsample < 1.0


# Comparaciones independientes: cada fila cambia un único factor respecto de
# "Stumps" para aislar el efecto de min_samples_leaf y de subsample.
REGULARIZATION_EXPERIMENTS: tuple[RegularizationExperiment, ...] = (
    RegularizationExperiment("base_complex", "Base compleja", 3, 1, 1.0),
    RegularizationExperiment("stumps", "Stumps", 1, 1, 1.0),
    RegularizationExperiment("leaf_only", "Solo leaf", 1, 20, 1.0),
    RegularizationExperiment("subsample_only", "Solo subsample", 1, 1, 0.8),
    RegularizationExperiment("combined", "Combinada", 1, 20, 0.8),
)


# ---------------------------------------------------------------------------
# Utilidades generales
# ---------------------------------------------------------------------------

def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def seed_schedule(base_seed: int, count: int) -> list[int]:
    """Semillas deterministas; la primera siempre es la semilla base."""
    if count < 1:
        raise ValueError("SEED_COUNT_MUST_BE_POSITIVE")
    return [int(base_seed + SEED_STEP * index) for index in range(count)]


def seeds_required(subsample: float, requested: int) -> int:
    """Modelos deterministas (subsample=1) solo necesitan una semilla.

    Se conserva la cantidad pedida para uniformidad del reporte cuando el
    llamador lo prefiera; esta función indica el mínimo necesario.
    """
    return requested if subsample < 1.0 else 1


def parse_int_grid(text: str | Sequence[int]) -> list[int]:
    if isinstance(text, str):
        values = [int(item.strip().replace(".", "")) for item in text.split(",") if item.strip()]
    else:
        values = [int(item) for item in text]
    if not values or any(value < 1 for value in values):
        raise ValueError("ESTIMATOR_GRID_INVALID")
    return sorted(set(values))


# ---------------------------------------------------------------------------
# Línea base nula y diagnóstico de subajuste
# ---------------------------------------------------------------------------

def null_pr_auc(y_true) -> float:
    """PR-AUC esperado de un clasificador sin información: la prevalencia."""
    y_true = np.asarray(y_true)
    if y_true.size == 0:
        raise ValueError("EMPTY_TARGET")
    return float(np.mean(y_true))


def pr_auc_lift_assessment(
    pr_auc_point: float,
    pr_auc_interval: Mapping[str, float] | None,
    prevalence: float,
    min_lift: float = DEFAULT_MIN_PR_AUC_LIFT,
) -> dict:
    """Evalúa si PR-AUC demuestra una mejora material sobre la prevalencia.

    Reemplaza la regla anterior ``validation_pr_auc < 0.50``. La decisión usa
    el límite inferior del IC 95 % cuando está disponible; si no lo está, se
    informa la mejora puntual y se marca la evidencia como insuficiente.
    """
    improvement = float(pr_auc_point - prevalence)
    result = {
        "nullPrAuc": float(prevalence),
        "prAuc": float(pr_auc_point),
        "improvement": improvement,
        "minimumMaterialLift": float(min_lift),
    }
    if pr_auc_interval is None:
        result.update({
            "ciAvailable": False,
            "lowerImprovement95": None,
            "materialImprovementDemonstrated": None,
            "possibleUnderfitting": improvement < min_lift,
        })
        return result
    lower_improvement = float(pr_auc_interval["lower95"] - prevalence)
    demonstrated = lower_improvement >= min_lift
    result.update({
        "ciAvailable": True,
        "prAucLower95": float(pr_auc_interval["lower95"]),
        "prAucUpper95": float(pr_auc_interval["upper95"]),
        "lowerImprovement95": lower_improvement,
        "materialImprovementDemonstrated": bool(demonstrated),
        "possibleUnderfitting": not demonstrated,
    })
    return result


# ---------------------------------------------------------------------------
# Bootstrap agrupado
# ---------------------------------------------------------------------------

def percentile_interval(values) -> dict:
    array = np.asarray(values, dtype=np.float64)
    lower, median, upper = np.quantile(array, [0.025, 0.5, 0.975])
    return {"lower95": float(lower), "median": float(median), "upper95": float(upper)}


def _threshold_rates(y_true, probabilities, threshold):
    predicted = probabilities >= threshold
    positives = y_true == 1
    controls = ~positives
    tp = int(np.sum(predicted & positives))
    fn = int(np.sum(~predicted & positives))
    fp = int(np.sum(predicted & controls))
    tn = int(np.sum(~predicted & controls))
    recall = tp / (tp + fn) if tp + fn else 0.0
    fpr = fp / (fp + tn) if fp + tn else 0.0
    return float(recall), float(fpr)


def sample_metrics(y_true, probabilities, threshold: float | None = None) -> dict:
    y_true = np.asarray(y_true, dtype=np.int8)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    result = {
        "prAuc": float(average_precision_score(y_true, probabilities)),
        "rocAuc": float(roc_auc_score(y_true, probabilities)),
    }
    if threshold is not None:
        recall, fpr = _threshold_rates(y_true, probabilities, float(threshold))
        result["recall"] = recall
        result["falsePositiveRate"] = fpr
    return result


def grouped_bootstrap(
    y_true,
    groups,
    predictions: Mapping[str, np.ndarray],
    thresholds: Mapping[str, float] | None = None,
    repetitions: int = DEFAULT_BOOTSTRAP_REPETITIONS,
    seed: int = 20260927,
    reference: str | None = None,
) -> dict:
    """Bootstrap remuestreando grupos ``matchedCaseId`` completos.

    Todos los modelos se evalúan sobre los mismos índices en cada repetición,
    de modo que las diferencias respecto de ``reference`` son pareadas. Las
    repeticiones sin ambas clases se descartan y se vuelven a sortear.
    """
    if repetitions < 1:
        raise ValueError("BOOTSTRAP_REPETITIONS_MUST_BE_POSITIVE")
    y_true = np.asarray(y_true, dtype=np.int8)
    groups = np.asarray(groups).astype(str)
    if len(y_true) != len(groups):
        raise ValueError("TARGET_GROUP_LENGTH_MISMATCH")
    predictions = {name: np.asarray(values, dtype=np.float64) for name, values in predictions.items()}
    for name, values in predictions.items():
        if len(values) != len(y_true):
            raise ValueError(f"PREDICTION_LENGTH_MISMATCH:{name}")
    if reference is not None and reference not in predictions:
        raise ValueError("REFERENCE_MODEL_NOT_FOUND")
    thresholds = dict(thresholds or {})

    unique_groups = np.unique(groups)
    index_by_group = {group: np.flatnonzero(groups == group) for group in unique_groups}
    rng = np.random.default_rng(seed)
    samples: dict[str, dict[str, list[float]]] = {name: {} for name in predictions}
    completed = 0
    discarded = 0
    while completed < repetitions:
        chosen = rng.choice(unique_groups, size=len(unique_groups), replace=True)
        indices = np.concatenate([index_by_group[group] for group in chosen])
        sample_y = y_true[indices]
        if sample_y.min() == sample_y.max():
            discarded += 1
            if discarded > repetitions * 10:
                raise ValueError("BOOTSTRAP_CANNOT_DRAW_BOTH_CLASSES")
            continue
        for name, values in predictions.items():
            metrics = sample_metrics(sample_y, values[indices], thresholds.get(name))
            for metric, value in metrics.items():
                samples[name].setdefault(metric, []).append(value)
        completed += 1

    point = {
        name: sample_metrics(y_true, values, thresholds.get(name))
        for name, values in predictions.items()
    }
    intervals = {
        name: {
            metric: {"point": point[name][metric], **percentile_interval(values)}
            for metric, values in metric_samples.items()
        }
        for name, metric_samples in samples.items()
    }
    differences = {}
    if reference is not None:
        for name in predictions:
            if name == reference:
                continue
            differences[name] = {}
            for metric, values in samples[name].items():
                if metric not in samples[reference]:
                    continue
                delta = np.asarray(values) - np.asarray(samples[reference][metric])
                interval = percentile_interval(delta)
                differences[name][metric] = {
                    "point": float(point[name][metric] - point[reference][metric]),
                    **interval,
                    "includesZero": bool(interval["lower95"] <= 0 <= interval["upper95"]),
                }
    return {
        "method": "grouped_bootstrap_by_matchedCaseId",
        "repetitions": int(repetitions),
        "discardedSingleClassDraws": int(discarded),
        "groups": int(len(unique_groups)),
        "rows": int(len(y_true)),
        "seed": int(seed),
        "reference": reference,
        "intervals": intervals,
        "pairedDifferences": differences,
    }


# ---------------------------------------------------------------------------
# Early stopping externo y predefinido
# ---------------------------------------------------------------------------

def early_stopping_select(
    validation_losses: Sequence[float],
    patience: int = DEFAULT_EARLY_STOPPING_PATIENCE,
    min_delta: float = DEFAULT_EARLY_STOPPING_MIN_DELTA,
) -> dict:
    """Aplica una regla de paciencia sobre la pérdida de validación por etapa.

    Una iteración cuenta como mejora solo si reduce la mejor pérdida en al
    menos ``min_delta``. La búsqueda se detiene tras ``patience`` iteraciones
    consecutivas sin mejora. Las iteraciones son 1-indexadas.
    """
    if patience < 1:
        raise ValueError("EARLY_STOPPING_PATIENCE_MUST_BE_POSITIVE")
    if min_delta < 0:
        raise ValueError("EARLY_STOPPING_MIN_DELTA_MUST_BE_NON_NEGATIVE")
    losses = np.asarray(validation_losses, dtype=np.float64)
    if losses.size == 0 or not np.isfinite(losses).all():
        raise ValueError("VALIDATION_LOSSES_INVALID")
    best_loss = np.inf
    best_iteration = 0
    waited = 0
    stopped_at = int(losses.size)
    stopped_early = False
    for iteration, loss in enumerate(losses, 1):
        if loss < best_loss - min_delta:
            best_loss = float(loss)
            best_iteration = iteration
            waited = 0
        else:
            waited += 1
            if waited >= patience:
                stopped_at = iteration
                stopped_early = True
                break
    search_maximum = int(losses.size)
    return {
        "rule": "patience_on_validation_log_loss",
        "patience": int(patience),
        "minDelta": float(min_delta),
        "searchMaximum": search_maximum,
        "bestIteration": int(best_iteration),
        "bestValidationLogLoss": float(best_loss),
        "stoppedAtIteration": int(stopped_at),
        "stoppedEarly": bool(stopped_early),
        # Si la regla no se activó, no hay evidencia de convergencia dentro
        # de la búsqueda: el máximo debe ampliarse antes de congelar.
        "convergenceDemonstrated": bool(stopped_early),
        "absoluteMinimumIteration": int(np.argmin(losses) + 1),
        "absoluteMinimumValidationLogLoss": float(losses.min()),
    }


# ---------------------------------------------------------------------------
# Registro de particiones abiertas
# ---------------------------------------------------------------------------

class PartitionAlreadyOpenedError(RuntimeError):
    pass


def load_ledger(path: str | Path) -> dict:
    path = Path(path)
    if not path.exists():
        return {"schemaVersion": 1, "openings": []}
    ledger = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(ledger.get("openings"), list):
        raise ValueError("LEDGER_INVALID")
    return ledger


def find_openings(ledger: Mapping, dataset_hash: str, partition: str) -> list[dict]:
    if partition not in LEDGER_PARTITIONS:
        raise ValueError(f"UNKNOWN_PARTITION:{partition}")
    return [
        item for item in ledger.get("openings", [])
        if item.get("datasetHash") == dataset_hash and item.get("partition") == partition
    ]


def assert_partition_unopened(ledger: Mapping, dataset_hash: str, partition: str) -> None:
    previous = find_openings(ledger, dataset_hash, partition)
    if previous:
        opened_for = ", ".join(sorted({str(item.get("openedFor")) for item in previous}))
        raise PartitionAlreadyOpenedError(
            f"PARTITION_ALREADY_OPENED:{partition}:{dataset_hash}:{opened_for}. "
            "Una partición abierta no puede usarse para seleccionar ni confirmar "
            "otro modelo; se requiere una nueva cohorte temporal."
        )


def record_opening(path: str | Path, entry: Mapping) -> dict:
    required = {"partition", "datasetHash", "openedFor", "purpose"}
    missing = required - set(entry)
    if missing:
        raise ValueError(f"LEDGER_ENTRY_MISSING:{','.join(sorted(missing))}")
    path = Path(path)
    ledger = load_ledger(path)
    assert_partition_unopened(ledger, entry["datasetHash"], entry["partition"])
    record = {"openedAtUtc": utc_now(), "reusableForSelection": False, **dict(entry)}
    ledger["openings"].append(record)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return record


def experiments_as_dicts() -> list[dict]:
    return [{**asdict(item), "stochastic": item.stochastic} for item in REGULARIZATION_EXPERIMENTS]
