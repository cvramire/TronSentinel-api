#!/usr/bin/env python3
"""Pruebas de las reglas de gobernanza. Ejecutar: python3 -m unittest test_onchain_governance"""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from onchain_governance import (
    REGULARIZATION_EXPERIMENTS,
    PartitionAlreadyOpenedError,
    assert_partition_unopened,
    early_stopping_select,
    grouped_bootstrap,
    load_ledger,
    null_pr_auc,
    parse_int_grid,
    pr_auc_lift_assessment,
    record_opening,
    seed_schedule,
)


LEDGER = Path(__file__).resolve().parents[2] / "governance" / "data-openings.json"
DEV_DATASET_HASH = "1039cb723b12f11b7793394cef430d5eea0e97cac6582bf277fa691c86558585"
EXTERNAL_HOLDOUT_HASH = "c144de87009d45517a6c0164edf7dd2371080188e2ea0e78ddc336f8a3216a1d"


class NullBaselineTest(unittest.TestCase):
    def test_null_pr_auc_is_prevalence(self):
        self.assertAlmostEqual(null_pr_auc([1, 0, 0, 0, 0]), 0.2)

    def test_lift_uses_lower_bound(self):
        weak = pr_auc_lift_assessment(0.40, {"lower95": 0.25, "upper95": 0.55}, 0.2158, 0.10)
        self.assertTrue(weak["possibleUnderfitting"])
        strong = pr_auc_lift_assessment(0.93, {"lower95": 0.89, "upper95": 0.97}, 0.2158, 0.10)
        self.assertFalse(strong["possibleUnderfitting"])
        self.assertTrue(strong["materialImprovementDemonstrated"])

    def test_no_universal_0_50_floor(self):
        # PR-AUC < 0.50 puede ser aprendizaje material cuando la prevalencia es baja.
        result = pr_auc_lift_assessment(0.45, {"lower95": 0.30, "upper95": 0.60}, 0.05, 0.10)
        self.assertFalse(result["possibleUnderfitting"])


class GroupedBootstrapTest(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(1)
        self.groups = np.repeat([f"g{i}" for i in range(40)], 5)
        self.y = np.tile([1, 0, 0, 0, 0], 40)
        self.good = self.y * 0.6 + rng.uniform(0, 0.5, len(self.y))
        self.noise = rng.uniform(0, 1, len(self.y))

    def test_reports_all_metrics_and_paired_differences(self):
        result = grouped_bootstrap(
            self.y, self.groups, {"good": self.good, "noise": self.noise},
            thresholds={"good": 0.5, "noise": 0.5}, repetitions=200, seed=3, reference="noise",
        )
        self.assertEqual(result["groups"], 40)
        self.assertEqual(set(result["intervals"]["good"]), {"prAuc", "rocAuc", "recall", "falsePositiveRate"})
        difference = result["pairedDifferences"]["good"]["prAuc"]
        self.assertGreater(difference["lower95"], 0)
        self.assertFalse(difference["includesZero"])

    def test_identical_models_include_zero(self):
        result = grouped_bootstrap(self.y, self.groups, {"a": self.good, "b": self.good.copy()},
                                   repetitions=100, seed=4, reference="a")
        self.assertEqual(result["pairedDifferences"]["b"]["prAuc"]["lower95"], 0.0)
        self.assertTrue(result["pairedDifferences"]["b"]["prAuc"]["includesZero"])

    def test_deterministic(self):
        first = grouped_bootstrap(self.y, self.groups, {"a": self.good}, repetitions=50, seed=9)
        second = grouped_bootstrap(self.y, self.groups, {"a": self.good}, repetitions=50, seed=9)
        self.assertEqual(first, second)


class EarlyStoppingTest(unittest.TestCase):
    def test_stops_after_patience(self):
        losses = list(np.linspace(1.0, 0.5, 100)) + [0.5005] * 80
        rule = early_stopping_select(losses, patience=50, min_delta=1e-4)
        self.assertEqual(rule["bestIteration"], 100)
        self.assertTrue(rule["stoppedEarly"])
        self.assertEqual(rule["stoppedAtIteration"], 150)

    def test_min_delta_ignores_tiny_improvements(self):
        losses = [1.0, 0.9] + [0.9 - 1e-6 * i for i in range(1, 60)]
        rule = early_stopping_select(losses, patience=50, min_delta=1e-4)
        self.assertEqual(rule["bestIteration"], 2)
        self.assertNotEqual(rule["absoluteMinimumIteration"], rule["bestIteration"])

    def test_no_convergence_when_still_improving(self):
        rule = early_stopping_select(np.linspace(1, 0.1, 300), patience=50)
        self.assertFalse(rule["convergenceDemonstrated"])
        self.assertEqual(rule["bestIteration"], 300)


class PolicyConstantsTest(unittest.TestCase):
    def test_seed_schedule_starts_at_base(self):
        seeds = seed_schedule(20260927, 30)
        self.assertEqual(seeds[0], 20260927)
        self.assertEqual(len(set(seeds)), 30)

    def test_grid_accepts_spanish_thousands(self):
        self.assertEqual(parse_int_grid("150, 300, 500, 700, 900, 1.000"), [150, 300, 500, 700, 900, 1000])

    def test_five_independent_experiments(self):
        table = {item.key: (item.max_depth, item.min_samples_leaf, item.subsample) for item in REGULARIZATION_EXPERIMENTS}
        self.assertEqual(table, {
            "base_complex": (3, 1, 1.0), "stumps": (1, 1, 1.0), "leaf_only": (1, 20, 1.0),
            "subsample_only": (1, 1, 0.8), "combined": (1, 20, 0.8),
        })


class LedgerTest(unittest.TestCase):
    def test_repository_ledger_marks_consumed_partitions(self):
        ledger = load_ledger(LEDGER)
        with self.assertRaises(PartitionAlreadyOpenedError):
            assert_partition_unopened(ledger, DEV_DATASET_HASH, "internal-test")
        with self.assertRaises(PartitionAlreadyOpenedError):
            assert_partition_unopened(ledger, EXTERNAL_HOLDOUT_HASH, "external-holdout")

    def test_record_then_refuse_second_opening(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.json"
            entry = {"partition": "internal-test", "datasetHash": "abc", "openedFor": "m1", "purpose": "t"}
            record_opening(path, entry)
            with self.assertRaises(PartitionAlreadyOpenedError):
                record_opening(path, {**entry, "openedFor": "m2"})
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(saved["openings"]), 1)
            self.assertFalse(saved["openings"][0]["reusableForSelection"])


if __name__ == "__main__":
    unittest.main()
