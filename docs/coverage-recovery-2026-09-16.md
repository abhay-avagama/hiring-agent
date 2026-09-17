# Coverage recovery — 16 September 2026

Status: offline diagnosis and regression fix complete; live pilot **not executed**. The execution safety check requires explicit approval of the network batch. No shared catalog, registry, snapshot, or production service was modified by this work.

## Measured baseline

The committed catalog contains 5,612 sources. This is an inventory count, not a configured ceiling, and not a count of distinct employers with jobs in a requested country.

| Provider | Catalog sources |
| --- | ---: |
| Ashby | 1,179 |
| Workday | 1,149 |
| Workable | 808 |
| Breezy | 753 |
| SmartRecruiters | 614 |
| Greenhouse | 580 |
| Keka | 306 |
| Freshteam | 82 |
| Zoho Recruit | 78 |
| Company JobPosting sites | 43 |
| Lever | 14 |
| Recruitee | 1 |
| Accenture / Infosys / Capgemini / Amazon | 5 combined |

The 9,607-lead registry contains 1,682 uncatalogued Workable sources whose last attempt returned HTTP 429. These are throttled leads, not proven dead boards. Do not replay them in a burst or treat them as guaranteed additions.

There are also 93 uncatalogued, never-attempted Keka provider/token pairs and 96 unattempted Zoho pairs. Keka's random-token heuristic incorrectly inspects its mandatory routing UUID as though it were part of the company name. All 93 were excluded before a request. The fix applies the heuristic only to the tenant component for Keka, retaining source URL validation, test-tenant exclusion, live structured-payload verification, and the explicitly labeled `provider_board` identity tier. A synthetic integration test fails before the fix and passes after it. Existing sources sharing a tenant must be excluded separately from a growth sample.

## Proposed first batch — approval required

- Existing leads only; no new Common Crawl or HTML discovery.
- Deterministic ascending source-key samples: 30 never-attempted Keka leads, 20 never-attempted Zoho leads, 10 Workable leads whose last result was HTTP 429.
- Exclude catalogued provider/token pairs; also exclude already-covered Keka tenants.
- One request at a time, at least 1,500 ms between requests, 30-second per-request timeout, maximum 200 requests across the entire pilot (verification and job retrieval combined).
- Stop a provider immediately after HTTP 429. After ten attempted boards, stop it if transport/throttle failures exceed 10% of its actual network requests. Empty boards and invalid schemas remain explicit verification rejections, not transport failures.
- Only existing public structured adapters; no proxies, authentication changes, or weakened identity rules.
- Verification and successful job retrieval write solely into `.openings/recovery-2026-09-16/`. No automatic promotion to shared data or deployment.
- Report source attempts, verified boards, successful full-feed retrievals, jobs, India-eligible jobs, and sources with India-eligible jobs separately. Count neither catalog admission nor tenant presence as country coverage. Do not call provider-board labels verified employer domains.

The isolated runner is `.openings/recovery-pilot.ts`. It uses the current verifier fix but the already-released 0.1.37 job adapter/classifier, avoiding unrelated local classification and Workday changes. Before promotion, inspect names, duplicate tenants/employers, actual role/country coverage and failed retrievals. The resulting verified catalog is staging only, not a production change.

## Next coverage tracks

1. Measure recovery yield before increasing the batch size. Expand only healthy, productive provider samples.
2. Increase Lever/Recruitee discovery using the current board-verification policy, not obsolete assumptions from the earlier company-domain-only rounds. Separately scope discovery request caps and provenance.
3. Fill named missing employers and role/city gaps, prioritizing candidate-visible value over board count. Existing market-map leads may help, but must first be inspected and deduplicated.
4. Preserve descriptions during normal refreshes using the shipped experience fix. More sources with unusable requirements are not equivalent to better searchable coverage.

No numeric promise of additional boards or jobs is made before the pilot runs.
