# Hyderabad navigation field evaluation

This bundle contains **40 proposed destinations and zero measured journeys**. The queue prioritises 33 catalogue listings in Jubilee Hills/Kokapet plus 7 nearby supplemental destinations. Catalogue coordinates and addresses remain source hints. Every field verification and verified entrance is null until a person checks it. None of this creates production GPS traces or verifies a business automatically.

## Collect comparable observations

1. Review `priority-cases.json`. Confirm the business still operates, the correct branch, public access, and the entrance. Record permissioned reference evidence with a timestamp before evaluating route quality. Choose an origin appropriate to that trip; do not route to a property centre as though it were an entrance.
2. Record each provider's actual outcome independently. Use the same origin (within 30 metres), destination reference, travel mode, and departures within 15 minutes for a paired run. Keep weather, traffic period and access conditions comparable. Use separate observers/vehicles where necessary; do not operate a phone while driving. Pair the two observations with the same `pairID` and `caseID`.
3. Measure initial predicted duration and actual travel duration in seconds. Record wrong gate, wrong side, unsafe instructions, final distance from the independently verified entrance, and whether the correct branch was found. Use `null` when not assessed. Capture search latency in milliseconds separately. A wrong-side flag needs road/entrance evidence, not an inference from a screenshot.
4. Record interrupted journeys as `incomplete`, failures as `error`, and unavailable modes as `unsupported`. Mapbox has no documented motorcycle profile; never substitute bicycle/car for two-wheeler. Compare Google two-wheeler against real ground truth separately rather than inventing a Mapbox counterpart.
5. Keep the observed facts in `observations-template.json` or a copy matching `field-observations.schema.json`. `evidenceRef` and `referenceEvidenceRef` are references to permissioned field notes, not harvested provider datasets. Do not store provider route geometry, tiles, photos or search responses in this bundle. Use pseudonymous observation IDs and avoid home addresses or identifiable bystanders.

The schema permits `synthetic: true` only so dry-run fixtures can be identified and excluded. Production comparisons must use real recorded journeys. The bundled unit-test fixtures are synthetic and are never written to the field report.

## Run the evaluator

```sh
python3 platform/tools/navigation-evaluation/evaluate-field-routes.py \
  platform/tools/navigation-evaluation/observations-template.json \
  --output platform/tools/navigation-evaluation/field-report.json
```

No API credentials or external packages are needed. The evaluator validates every keyword used by the bundled schema, rejects duplicate observations, invalid numbers, unsupported motorcycle substitutions and entrance judgments without reference evidence. It separates providers/modes, shows measured denominators, excludes synthetic records, and only pairs completed journeys with comparable origins/departure windows.

The report includes median/p90 absolute ETA error, proportional ETA error, entrance error, search latency, wrong-gate/wrong-side/unsafe-instruction rates and correct-branch search rate. A negative paired ETA-error difference means Google was closer for that pair; it is not proof that Google is better everywhere. Review dangerous guidance separately rather than averaging it away. The calculator does not verify the honesty of uploaded evidence.

Run unit checks with:

```sh
python3 platform/tools/navigation-evaluation/test-field-evaluator.py
```

## Before a product decision

Test peak/off-peak periods, weekend evenings, walking approaches, service roads, divided roads, flyover/surface-road ambiguity, hospital gates and campus restrictions. Review at least 20 comparable pairs per supported mode across different corridors before drawing even a preliminary conclusion; this is a suggested minimum, not a statistical guarantee. Repeat failure cases and use confidence intervals before claiming a small difference is meaningful.

The shipped `empty-field-report.json` reports `fieldwork_required`. Simulator success verifies UI/network integration, not local navigation accuracy. A human field pass and activation of any required commercial services remain necessary.
