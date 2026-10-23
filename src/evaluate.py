"""Métricas de evaluación con incertidumbre para TronSentinel.

Uso::

    python -m src.evaluate --split validation      # train | validation | test | external_holdout

El test interno y el holdout externo ya fueron abiertos (ver ``governance/data-openings.json``):
evaluarlos es solo **informativo** y nunca debe usarse para cambiar parámetros o el umbral.
"""

from __future__ import annotations

import argparse

import numpy as np
from sklearn.metrics import (accuracy_score, average_precision_score, brier_score_loss, confusion_matrix,
                             f1_score, precision_score, recall_score, roc_auc_score)

from src.utils import get_logger

LOGGER = get_logger(__name__)
OPENED_SPLITS = {"test", "external_holdout"}


def classification_metrics(y_true, probabilities, threshold: float) -> dict:
    """Métricas de la clase positiva (wallet de riesgo) en un umbral dado."""
    y_true = np.asarray(y_true, dtype=int)
    probabilities = np.asarray(probabilities, dtype=float)
    if len(y_true) != len(probabilities):
        raise ValueError("y_true y probabilities deben tener el mismo largo")
    y_pred = (probabilities >= threshold).astype(int)
    controls = y_true == 0
    both = len(set(y_true)) == 2
    return {
        "accuracy": accuracy_score(y_true, y_pred),
        "recall": recall_score(y_true, y_pred, zero_division=0),
        "precision": precision_score(y_true, y_pred, zero_division=0),
        "f1": f1_score(y_true, y_pred, zero_division=0),
        "fpr": float(y_pred[controls].mean()) if controls.any() else float("nan"),
        "auc": roc_auc_score(y_true, probabilities) if both else float("nan"),
        "auc_pr": average_precision_score(y_true, probabilities) if both else float("nan"),
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


def full_report(y_true, probabilities, threshold: float) -> dict:
    """Métricas puntuales + matriz de confusión + IC de Wilson para recall y FPR + Brier."""
    y_true = np.asarray(y_true, dtype=int)
    y_pred = (np.asarray(probabilities) >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    report = classification_metrics(y_true, probabilities, threshold)
    _, recall_low, recall_high = wilson_interval(int(tp), int(tp + fn))
    _, fpr_low, fpr_high = wilson_interval(int(fp), int(fp + tn))
    report.update({
        "brier": brier_score_loss(y_true, probabilities),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "recall_ci95": [recall_low, recall_high],
        "fpr_ci95": [fpr_low, fpr_high],
        "null_pr_auc": float(y_true.mean()),
    })
    return report


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


def main() -> None:
    from src.data_processing import get_split, load_dataset, split_xy
    from src.model import load_model, predict_proba, threshold
    from src.utils import load_config

    parser = argparse.ArgumentParser(description="Evalúa el artefacto desplegado en una partición")
    parser.add_argument("--split", default="validation",
                        choices=["train", "validation", "test", "external_holdout"])
    parser.add_argument("--config", default=None)
    args = parser.parse_args()
    config = load_config(args.config)
    if args.split in OPENED_SPLITS:
        LOGGER.warning("La partición %s ya fue abierta: el resultado es informativo y no autoriza "
                       "cambiar parámetros ni umbral.", args.split)
    source = config["data"]["external_holdout" if args.split == "external_holdout" else "development"]
    X, y, _ = split_xy(get_split(load_dataset(source), args.split))
    model = load_model(config["artifacts"]["deployed_json"])
    report = full_report(y, predict_proba(model, X), threshold(model))
    print(f"{args.split}: n={len(y)} riesgosas={int(y.sum())}")
    for key in ["recall", "fpr", "precision", "f1", "auc", "auc_pr", "brier", "null_pr_auc"]:
        print(f"  {key:12s} {report[key]:.4f}")
    print(f"  recall IC95  [{report['recall_ci95'][0]:.3f}, {report['recall_ci95'][1]:.3f}]")
    print(f"  FPR IC95     [{report['fpr_ci95'][0]:.3f}, {report['fpr_ci95'][1]:.3f}]")
    print(f"  confusión    {report['confusion']}")


if __name__ == "__main__":
    main()
