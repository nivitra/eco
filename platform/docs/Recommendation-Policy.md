# Recommendation policy: intent-evidence-diversity-1

This is an explainable deterministic ranking system, not a trained model and not evidence of being the world's best recommender. The first priority is excluding incorrect/unsupported candidates before scoring.

Hard gates: inactive/closed/withdrawn/merged records; requested locality; explicit category exclusions; bar/venue-name/tag exclusions; explicit dismissed IDs; requested category mismatch. `requireVerifiedOpen` returns no matches until verified hours exist. Clear strict requests for unavailable vegan/accessibility/hours/budget certification also return no eligible matches. Ordinary discovery requests receive explicit unavailable-fact cautions. Venue/category membership does not certify alcohol-free, dietary, allergen or accessibility compliance.

Negation checks operate within punctuation/“but” clauses and six preceding tokens. “Don't want bars,” “not interested in nightlife,” and “no noisy bars” exclude bars. “Not just”/“not only” are additive. Local UI scope only widens for an affirmative citywide phrase; “nothing outside Jubilee” narrows scope. This bounded English grammar is not universal language understanding; Telugu/Hindi and adversarial paraphrases require a larger evaluated parser before language-wide promises.

Scoring weights:

| Evidence | Weight |
|---|---:|
| Explicit category intent | +24 |
| User-selected category interest | +6 |
| Name token overlap | +7/token, capped +25 |
| Matched source/editorial tags | +6/tag, capped +18 |
| Explicit positive tags | +4/token, capped +12 |
| Explicit negative tags | −6/token, capped −18 |
| Saved/liked category affinity | +1.5/item, capped +4.5 |
| Directly liked place | +5 |
| Already saved | +1 |
| Editorial date category | +5 cafés / +3 food, art, nature |
| Editorial friends category | +3 |
| Landmark/nature intent | +8 |
| Supplied measured map distance | up to +4, decays with distance |

Selection covers explicitly requested available categories first. Later choices subtract 5 for each already-selected same-category option, 0.75 for each same-neighborhood option, and up to 5 for highest source-tag Jaccard similarity. These are diversity preferences, not exclusions: a coffee-only request can still return several cafés. Stable place-ID ordering breaks ties deterministically. Explicit saved/liked signals are used without recording movement history or inferring sensitive identity attributes.

`Recommendation-Evaluation.json` records the data hash, policy version, timestamp, output IDs and 23 existing curated intent scenarios. All 23 pass expected category coverage in the top five, source-ID validity, locality and no-bars assertions. Additional tests cover dismissals/likes, negative tags, missing verified hours, closed entries, optional distance semantics, multi-category diversity, input-order stability, five negation/locality challenges and dietary/accessibility/budget uncertainty. These tests establish those invariants; they do not measure satisfaction, map accuracy, current venue operations, conversion, safety or market-leading relevance. Add blind human pairwise preference studies, saved-to-visit outcomes with consent, multilingual cases and source refresh coverage before changing that claim.

AI uses the same eligibility and ranking logic to select its grounded context. Validating returned IDs prevents out-of-catalog recommendation cards; prose claims still require semantic evaluation. Provider text is buffered until its full JSON and recommendation IDs pass checks.
