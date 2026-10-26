#!/usr/bin/env python3
"""Offline evaluator for independently observed journeys; no provider calls."""
import argparse
import datetime as dt
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def validate(value, schema, path="$"):
    """Enforce every keyword used by this bundle's deliberately small schema."""
    types = schema.get("type", [])
    types = [types] if isinstance(types, str) else types
    kind = "null" if value is None else "boolean" if isinstance(value, bool) else "object" if isinstance(value, dict) else "array" if isinstance(value, list) else "string" if isinstance(value, str) else "integer" if isinstance(value, int) else "number" if isinstance(value, float) else "unknown"
    if types and kind not in types and not (kind == "integer" and "number" in types):
        raise ValueError(f"{path}: expected {types}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: unsupported value")
    if "const" in schema and value != schema["const"]:
        raise ValueError(f"{path}: unexpected schema version")
    if isinstance(value, dict):
        missing = set(schema.get("required", [])) - value.keys()
        extra = value.keys() - schema.get("properties", {}).keys()
        if missing or (extra and schema.get("additionalProperties") is False):
            raise ValueError(f"{path}: missing {sorted(missing)}; unexpected {sorted(extra)}")
        for key, item in value.items():
            validate(item, schema.get("properties", {}).get(key, {}), f"{path}.{key}")
    elif isinstance(value, list):
        if len(value) > schema.get("maxItems", math.inf):
            raise ValueError(f"{path}: too many records")
        for index, item in enumerate(value):
            validate(item, schema.get("items", {}), f"{path}[{index}]")
    elif isinstance(value, str):
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", math.inf):
            raise ValueError(f"{path}: invalid text length")
        if schema.get("minLength", 0) and not value.strip():
            raise ValueError(f"{path}: blank text")
    elif kind in ("integer", "number"):
        if not math.isfinite(value) or not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            raise ValueError(f"{path}: invalid numeric value")


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamps must include a timezone")
    return parsed


def distance(a, b):
    lat1, lat2 = map(math.radians, [a["latitude"], b["latitude"]])
    dlat = lat2 - lat1
    dlon = math.radians(b["longitude"] - a["longitude"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6_371_000 * 2 * math.asin(min(1, math.sqrt(h)))


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * p
    low, high = math.floor(index), math.ceil(index)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (index - low), 3)


def distribution(values):
    return {"count": len(values), "median": percentile(values, .5), "p90": percentile(values, .9)}


def rate(rows, field):
    assessed = [row[field] for row in rows if row[field] is not None]
    return {"assessed": len(assessed), "trueCount": sum(assessed), "fraction": sum(assessed) / len(assessed) if assessed else None}


def evaluate(data, cases):
    schema = json.loads((ROOT / "field-observations.schema.json").read_text())
    validate(data, schema)
    known = {case["caseID"] for case in cases["cases"]}
    seen = set()
    runs = set()
    for row in data["observations"]:
        if row["id"] in seen:
            raise ValueError("Duplicate observation ID")
        seen.add(row["id"])
        run = (row["caseID"], row["pairID"], row["provider"], row["mode"])
        if run in runs:
            raise ValueError("Duplicate provider observation within a paired run")
        runs.add(run)
        if row["caseID"] not in known:
            raise ValueError("Unknown field case")
        started = timestamp(row["startedAt"])
        if started > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
            raise ValueError("An observation cannot start in the future")
        if row["status"] == "completed" and (row["predictedDurationSeconds"] is None or row["actualDurationSeconds"] is None):
            raise ValueError("Completed journeys require predicted and observed durations")
        if row["status"] != "completed" and row["actualDurationSeconds"] is not None:
            raise ValueError("Do not report completed travel time for an incomplete journey")
        if row["provider"] == "mapbox" and row["mode"] == "two-wheeler" and row["status"] != "unsupported":
            raise ValueError("Mapbox has no documented motorcycle profile; never substitute bicycle/car")
        entrance_assessed = any(row[key] is not None for key in ["wrongGate", "wrongSide", "unsafeInstruction", "entranceErrorMetres", "searchFoundCorrectBranch"])
        if entrance_assessed:
            if not row["referenceEvidenceRef"] or not row["referenceVerifiedAt"]:
                raise ValueError("Branch, entrance and safety assessments need independent reference evidence")
            if timestamp(row["referenceVerifiedAt"]) > started:
                raise ValueError("Reference verification must precede the field observation")
    real = [row for row in data["observations"] if not row["synthetic"]]
    metrics = {}
    for provider in ["mapbox", "google"]:
        for mode in ["driving", "walking", "two-wheeler"]:
            rows = [r for r in real if r["provider"] == provider and r["mode"] == mode]
            completed = [r for r in rows if r["status"] == "completed"]
            errors = [abs(r["actualDurationSeconds"] - r["predictedDurationSeconds"]) for r in completed]
            metrics[f"{provider}:{mode}"] = {
                "observations": len(rows), "completed": len(completed),
                "unsupported": sum(r["status"] == "unsupported" for r in rows),
                "absoluteETAErrorSeconds": distribution(errors),
                "absoluteETAErrorFraction": distribution([abs(r["actualDurationSeconds"] - r["predictedDurationSeconds"]) / r["actualDurationSeconds"] for r in completed]),
                "wrongGate": rate(rows, "wrongGate"), "wrongSide": rate(rows, "wrongSide"),
                "unsafeInstruction": rate(rows, "unsafeInstruction"),
                "searchFoundCorrectBranch": rate(rows, "searchFoundCorrectBranch"),
                "entranceErrorMetres": distribution([r["entranceErrorMetres"] for r in rows if r["entranceErrorMetres"] is not None]),
                "searchLatencyMilliseconds": distribution([r["searchLatencyMilliseconds"] for r in rows if r["searchLatencyMilliseconds"] is not None])
            }
    groups = {}
    for row in real:
        groups.setdefault((row["caseID"], row["pairID"], row["mode"]), {})[row["provider"]] = row
    pairs, excluded = [], []
    for (case, pair, mode), providers in groups.items():
        reason = None
        if set(providers) != {"mapbox", "google"}:
            reason = "missing other provider"
        else:
            a, b = providers["mapbox"], providers["google"]
            if a["status"] != "completed" or b["status"] != "completed":
                reason = "both journeys must be completed"
            elif not a["referenceEvidenceRef"] or a["referenceEvidenceRef"] != b["referenceEvidenceRef"]:
                reason = "destination reference evidence must match"
            elif distance(a["origin"], b["origin"]) > 30:
                reason = "origins more than 30 metres apart"
            elif abs((timestamp(a["startedAt"]) - timestamp(b["startedAt"])).total_seconds()) > 900:
                reason = "departures more than 15 minutes apart"
        if reason:
            excluded.append({"caseID": case, "pairID": pair, "mode": mode, "reason": reason})
        else:
            a_error = abs(a["actualDurationSeconds"] - a["predictedDurationSeconds"])
            b_error = abs(b["actualDurationSeconds"] - b["predictedDurationSeconds"])
            pairs.append({"caseID": case, "pairID": pair, "mode": mode, "googleMinusMapboxAbsoluteETAErrorSeconds": b_error - a_error})
    return {
        "status": "fieldwork_required" if not real else "observations_available_not_a_universal_winner",
        "realObservations": len(real), "syntheticObservationsExcluded": len(data["observations"]) - len(real),
        "metrics": metrics, "comparablePairs": pairs, "excludedPairs": excluded,
        "pairedETAErrorDifferenceSeconds": distribution([p["googleMinusMapboxAbsoluteETAErrorSeconds"] for p in pairs]),
        "interpretation": "A negative paired difference favours Google ETA accuracy for these observations only. Null is unmeasured, not zero. Match mode, departure window, weather, origin and independent destination reference; review all safety failures separately. No field winner is established by a simulator or synthetic data."
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("observations", type=Path)
    parser.add_argument("--cases", type=Path, default=ROOT / "priority-cases.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = evaluate(json.loads(args.observations.read_text()), json.loads(args.cases.read_text()))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(2, f"Invalid field observations: {error}\n")
    rendered = json.dumps(report, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
