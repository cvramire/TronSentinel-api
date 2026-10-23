"""Entrenamiento del clasificador de TronSentinel.

Gradient Boosting con pesos de clase balanceados calculados dentro de cada ajuste, de modo
que la ponderación se respeta también dentro de la validación cruzada.
"""

from __future__ import annotations

import numpy as np
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.ensemble import GradientBoostingClassifier

# Configuración del modelo desplegado v0.6.1 (stumps: el scorer de producción solo admite profundidad 1)
DEPLOYED_PARAMS = {
    "n_estimators": 150,
    "learning_rate": 0.04,
    "max_depth": 1,
    "min_samples_leaf": 20,
    "subsample": 0.8,
}
SEED = 20260927


class BalancedGradientBoosting(ClassifierMixin, BaseEstimator):
    """GradientBoostingClassifier con pesos balanceados por clase en cada ``fit``."""

    def __init__(self, n_estimators=150, learning_rate=0.04, max_depth=1,
                 min_samples_leaf=20, subsample=0.8, random_state=SEED):
        self.n_estimators = n_estimators
        self.learning_rate = learning_rate
        self.max_depth = max_depth
        self.min_samples_leaf = min_samples_leaf
        self.subsample = subsample
        self.random_state = random_state

    def fit(self, X, y):
        y = np.asarray(y, dtype=int)
        positives, controls = int(y.sum()), int(len(y) - y.sum())
        if positives == 0 or controls == 0:
            raise ValueError("FIT_REQUIRES_BOTH_CLASSES")
        weights = np.where(y == 1, len(y) / (2 * positives), len(y) / (2 * controls))
        self.model_ = GradientBoostingClassifier(
            n_estimators=int(self.n_estimators), learning_rate=float(self.learning_rate),
            max_depth=int(self.max_depth), min_samples_leaf=int(self.min_samples_leaf),
            subsample=float(self.subsample), random_state=self.random_state,
        ).fit(X, y, sample_weight=weights)
        self.classes_ = self.model_.classes_
        self.n_features_in_ = self.model_.n_features_in_
        return self

    def predict_proba(self, X):
        return self.model_.predict_proba(X)

    def predict(self, X):
        return self.model_.predict(X)

    @property
    def feature_importances_(self):
        return self.model_.feature_importances_
