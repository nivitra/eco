"""Synthetic unit fixtures; these are never written to the field report."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("evaluator", ROOT / "evaluate-field-routes.py")
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)
CASES = json.loads((ROOT / "priority-cases.json").read_text())


def row(provider="google", synthetic=True):
    return {"id": "test-" + provider, "caseID": CASES["cases"][0]["caseID"], "pairID": "synthetic-test-pair",
            "provider": provider, "mode": "driving", "status": "completed", "synthetic": synthetic,
            "startedAt": "2026-09-29T12:00:00Z", "origin": {"latitude": 17.4, "longitude": 78.4},
            "predictedDurationSeconds": 600, "actualDurationSeconds": 720,
            "wrongGate": False, "wrongSide": False, "unsafeInstruction": None,
            "entranceErrorMetres": 8, "searchFoundCorrectBranch": True, "searchLatencyMilliseconds": 400,
            "referenceEvidenceRef": "unit-fixture-only", "referenceVerifiedAt": "2026-09-29T11:00:00Z",
            "evidenceRef": "unit-fixture-only", "notes": "Synthetic test fixture; not an actual journey"}


def evaluate(rows):
    return evaluator.evaluate({"schemaVersion": 1, "observations": rows}, CASES)


class FieldEvaluatorTests(unittest.TestCase):
    def test_empty_and_synthetic_data_cannot_establish_field_measurements(self):
        for rows in [[], [row()]]:
            report = evaluate(rows)
            self.assertEqual(report["realObservations"], 0)
            self.assertEqual(report["status"], "fieldwork_required")
            self.assertIsNone(report["metrics"]["google:driving"]["wrongGate"]["fraction"])

    def test_aggregation_math_and_same_session_pairing(self):
        # The flag is toggled solely inside a unit test to exercise aggregation.
        a, b = row("mapbox", False), row("google", False)
        b["actualDurationSeconds"] = 660
        report = evaluate([a, b])
        self.assertEqual(report["pairedETAErrorDifferenceSeconds"]["median"], -60)
        self.assertEqual(len(report["comparablePairs"]), 1)
        self.assertEqual(report["metrics"]["mapbox:driving"]["absoluteETAErrorSeconds"]["median"], 120)

    def test_unpaired_late_and_distant_origins_are_not_comparable(self):
        a, b = row("mapbox", False), row("google", False)
        self.assertFalse(evaluate([a])["comparablePairs"])
        b["startedAt"] = "2026-09-29T13:00:00Z"
        self.assertFalse(evaluate([a, b])["comparablePairs"])
        b["startedAt"] = a["startedAt"]; b["origin"]["latitude"] += .01
        self.assertFalse(evaluate([a, b])["comparablePairs"])
        b["origin"] = copy.deepcopy(a["origin"]); b["referenceEvidenceRef"] = "different-gate-reference"
        self.assertFalse(evaluate([a, b])["comparablePairs"])

    def test_unknown_is_not_false_and_requires_correct_denominator(self):
        a, b = row("google", False), row("google", False)
        b["id"] = "test-second"; b["pairID"] = "test-second"; b["wrongGate"] = None
        report = evaluate([a, b])
        self.assertEqual(report["metrics"]["google:driving"]["wrongGate"]["assessed"], 1)

    def test_gate_assessments_require_independent_reference_evidence(self):
        value = row(); value["referenceEvidenceRef"] = None
        with self.assertRaises(ValueError): evaluate([value])

    def test_invalid_numbers_duplicate_ids_and_unknown_cases_are_rejected(self):
        for key, value in [("actualDurationSeconds", 0), ("predictedDurationSeconds", float("nan")), ("wrongGate", 1), ("caseID", "unknown")]:
            sample = row(); sample[key] = value
            with self.assertRaises(ValueError): evaluate([sample])
        with self.assertRaises(ValueError): evaluate([row(), copy.deepcopy(row())])

    def test_motorcycle_cannot_be_fabricated_from_mapbox_car_or_bike(self):
        value = row("mapbox"); value["mode"] = "two-wheeler"
        with self.assertRaises(ValueError): evaluate([value])
        value["status"] = "unsupported"; value["actualDurationSeconds"] = None
        self.assertEqual(evaluate([value])["realObservations"], 0)


if __name__ == "__main__":
    unittest.main()
