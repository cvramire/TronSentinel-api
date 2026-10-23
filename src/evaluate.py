"""Métricas de evaluación con incertidumbre para TronSentinel."""

from __future__ import annotations

import numpy as np
from sklearn.metrics import (accuracy_score, average_precision_score, f1_score,
                             precision_score, recall_score, roc_auc_score)


def classification_metrics(y_true, probabilities, threshold: float) -> dict:
    """Métricas de la clase positiva (wallet de riesgo) en un umbral dado."""
    y_true = np.asarray(y_true, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)
    y_pred = (probabilities >= threshold).astype(int)
    controls = y_true == 0
    return {
        "accuracy": accuracy_score(y_true, y_pred),
        "recall": recall_score(y_true, y_pred, zero_division=0),
        "precision": precision_score(y_true, y_pred, zero_division=0),
        "f1": f1_score(y_true, y_pred, zero_division=0),
        "fpr": float(y_pred[controls].mean()) if controls.any() else float("nan"),
        "auc": roc_auc_score(y_true, probabilities) if len(set(y_true)) == 2 else float("nan"),
        "auc_pr": average_precision_score(y_true, probabilities) if len(set(y_true)) == 2 else float("nan"),
    }


def wilson_interval(successes: int, total: int, z: float = 1.959964) -> tuple[float, float, float]:
    """Proporción y su intervalo de Wilson al 95 %."""
    if total == 0:
        return float("nan"), float("nan"), float("nan")
    p = successes / total
    denominator = 1 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    half = z * np.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return p, max(0.0, center - half), min(1.0, center + half)


def ppv_at_prevalence(recall: float, fpr: float, prevalence: float) -> float:
    """Precisión esperada cuando la proporción real de wallets riesgosas es ``prevalence``."""
    true_alerts = recall * prevalence
    false_alerts = fpr * (1 - prevalence)
    return true_alerts / (true_alerts + false_alerts) if true_alerts + false_alerts else float("nan")


def grouped_bootstrap_difference(y_true, groups, prob_a, prob_b, metric=average_precision_score,
                                 repetitions: int = 2000, seed: int = 42) -> dict:
    """Diferencia pareada metric(b) - metric(a) con bootstrap por grupo emparejado."""
    y_true, groups = np.asarray(y_true), np.asarray(groups).astype(str)
    prob_a, prob_b = np.asarray(prob_a), np.asarray(prob_b)
    unique = np.unique(groups)
    index = {g: np.flatnonzero(groups == g) for g in unique}
    rng = np.random.default_rng(seed)
    deltas = []
    while len(deltas) < repetitions:
        sample = np.concatenate([index[g] for g in rng.choice(unique, len(unique), replace=True)])
        if y_true[sample].min() == y_true[sample].max():
            continue
        deltas.append(metric(y_true[sample], prob_b[sample]) - metric(y_true[sample], prob_a[sample]))
    low, high = np.quantile(deltas, [0.025, 0.975])
    return {"point": metric(y_true, prob_b) - metric(y_true, prob_a), "lower95": low, "upper95": high,
            "includes_zero": bool(low <= 0 <= high)}
