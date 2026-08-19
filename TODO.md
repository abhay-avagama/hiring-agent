# TODO — next course of action

Grounded in `docs/PRD.md` (v0.3) and the repo's actual state as of 2026-08-19. Priority order.

## 1. Reconcile priority drift with the PRD — completed

`docs/PRD.md` v0.3 now records that the v1 MCP core is operational and that bounded maintainer-side corpus expansion has resumed to support the “hidden public jobs” proposition. Recommendation may refresh relevant verified sources at most once according to policy, but source discovery remains outside request-time workflows.

## 2. Commit or discard the pending corpus-expansion output — completed

Completed in `e0aeba1` (`data: expand verified India source corpus`) after schema, canonical-source, verification-metadata, duplicate, test, and typecheck validation. The commit contains 75 catalog sources, 79 candidates, and 2,379 enrichment leads.

## 3. Close the last v1 delivery-sequence gap: native resume extraction

`pdf_base64` / `docx_base64` resume formats are still hard-rejected with `unsupported_resume_format` (`src/candidate-profile.ts:43-44`). This is PRD delivery step 7, contingent on host-side (MCP client) text extraction "proving insufficient." Confirm whether that's now true; if so, scope native local PDF/DOCX parsing without violating the "resume content never persisted" constraint (PRD Privacy and security section).

**Codex review (2026-08-19):** Do not treat this as the next mandatory v1 item yet. The PRD explicitly reserves these formats without committing native parsing, and the Narayan PDF evaluation succeeded through host-side extraction. Native extraction becomes a priority only after we record concrete host failures such as lost layout, missing sections, corrupt offsets, or unavailable conversion. Until then, retain the stable `unsupported_resume_format` contract and prioritize job exploration quality and measurable corpus coverage.

## 4. Measure country coverage — completed

`docs/decision-maps/global-job-coverage.md` has two items still marked **Open**, not just "more sources":
- **#10** — measure the India campaign at scale (eligible-job count, distinct-employer count, source success rate, classification-confidence distribution) rather than just growing token count.
- **#11** — Workable's unauthenticated feed lacks a documented API contract; don't promote it from experimental until resolved.
- **#9** notes Lever/Ashby automatic identity verification is still an explicit follow-up, relevant if `data/enrichment-leads.json` is accumulating Lever/Ashby leads.

**Codex review (2026-08-19):** Item #10 is the strongest immediate next task. Add a deterministic country-coverage report containing verified sources, indexed sources, eligible jobs, distinct eligible employers, source success rate, provider distribution, eligibility-confidence distribution, discovery-to-verification yield, and partition freshness. Measure growth by useful job/employer coverage rather than candidate or ATS-token count.

Completed with the offline `coverage report --country CODE` command. The report distinguishes global catalog/index/funnel totals from country-cohort discovery provenance and job-level country eligibility. It reports orphaned and never-indexed partitions, latest rotation-batch health, global registry yield, global and country-cohort candidate-promotion yield, and actionable freshness buckets. Fixed `--as-of` timestamps make repeated output deterministic.

Before relying on the decision map, update its stale resolved decisions:

- **#4/#8:** failed refreshes no longer remove an existing partition. The crawler preserves stale jobs, reports the failed refresh, and retries it in a later rotation.
- **#5:** Workday is no longer excluded. It is a shipped enterprise adapter with bounded pagination, retry/backoff reporting, per-source caching, and rotating crawl batches.
- **#9:** Lever/Ashby verification is not universally dead. Strong company-owned redirect evidence is supported; weak name/domain/token matches remain intentionally insufficient. The remaining problem is acquiring more qualifying evidence at scale.
- **#11:** Workable remains correctly parked until its usage and stability contract is acceptable.

## 5. Build candidate-driven hidden-job exploration — completed

The user-facing differentiator should be finding relevant public jobs whose titles do not exactly match a conventional query. Add this above the existing matcher rather than creating a second matching implementation.

The exploration workflow should:

1. Derive role families and title aliases only from explicit intent and evidence-backed resume facts.
2. Search the local snapshot across titles, descriptions, skills, seniority, and experience requirements.
3. Preserve the existing matching contract: country, location, work-mode, and explicit exclusions remain hard gates; authorization uncertainty and mandatory education or experience shortfalls remain visible screening risks that prevent a strong fit and cap both scores below 80.
4. Return direct matches, non-obvious/hidden matches, and stretch matches separately, with evidence and keyword scores for every result.
5. Explain which title-family expansion surfaced each non-obvious result.
6. Search immediately, optionally refresh relevant verified sources once according to policy, then rematch once. It must never run source discovery inside the user request.

“Hidden jobs” means public roles that are difficult to discover through exact-title keyword search. It does not mean private, unpublished, authenticated, or access-controlled jobs.

Completed in the existing `recommend_jobs` MCP workflow. The matcher now derives bounded role-family aliases from explicit intent or validated resume inference, gives alias matches relevance credit, and returns direct, hidden, and stretch buckets. Hidden matches carry the exact alias, family, derivation source, and supporting resume fact IDs. The workflow still performs no source discovery and preserves its one-crawl/one-rematch ceiling.

## 6. Resume bounded source discovery — completed first round

Direction confirmed 2026-08-19: grow the verified job database further. This stays scoped to the existing job-seeker-facing product — deeper/broader `recommend_jobs` and `search_jobs` coverage, not a recruiter-sourcing feature. No accounts, billing, or gating design is in scope yet; that's a separate, later decision and must not be designed into the data or matching layer preemptively (PRD still excludes "recruiters sourcing candidates" as an audience — this expansion doesn't change that).

Two concrete, bounded next steps, informed by the yield diagnostic:

1. **Persist the cleaned Workday/Greenhouse enrichment result.** The earlier simulation dropped from 28 noisy candidates to 17 structurally valid ones once the `robots.txt`-as-board bug was fixed in `89423ac`. Re-run `sources enrich` against the same datasets now that the CXS-shape validation is live, persist the result, and run `sources verify` on the output.
2. **Unlock the Ashby backlog (1,198 leads, the single largest blocked group).** These are stuck because Ashby requires provider-structured identity or a replayed company-owned redirect — enrichment alone can't give them evidence. Local seed files already exist from prior work (`.openings/company-domains.json`, `.openings/lever-ashby-seeds.json`) — reuse them for `sources trace-careers` rather than regenerating. Measure yield before deciding whether a fresh Common Crawl discovery pass (last run 2026-08-11) is worth it.

After either step, re-run `coverage report --country IN` to measure the actual delta before deciding on a next round.

First bounded round completed 2026-08-19:

- The deterministic projection of 455 company-owned career-page identities matched 17 structurally valid Greenhouse/Workday candidates. Independent verification admitted Affinidi, Athena Health, and BlackRock for India; duplicate alternate boards, empty boards, stale endpoints, and feeds without India jobs were rejected or deferred with explicit outcomes.
- The targeted Flex/PostHog trace produced no redirect evidence. The 218-seed isolated trace against the existing Common Crawl report produced one verification-ready Ashby source, Bolna AI, which passed independent India verification. Yield was 1/218, so a fresh Common Crawl campaign is not justified yet.
- The four new sources crawled successfully. Fixed-reference coverage moved from 75 to 79 verified sources, 74 to 78 catalog-backed indexed sources, 48,234 to 48,539 indexed jobs, 6,106 to 6,177 India-eligible jobs, and 71 to 75 distinct eligible employer domains.
- Ashby's remaining raw-token backlog stays parked: company-owned redirect evidence, not another token-discovery pass, remains the bottleneck.

## Revised execution order

1. Resume bounded source discovery based on measured provider/employer/eligibility gaps (see §6 above).
2. Research optional transport adapters such as Bright Data or Oxylabs behind the fetch boundary; do not make proxy rotation a correctness dependency.
3. Revisit native PDF/DOCX extraction only when host-side extraction has documented failures.

## Already solid (no action needed)

- `skills/openings/SKILL.md` already matches the PRD's target "thin wrapper" shape — delegates to MCP tools, doesn't reproduce parsing/matching.
- Adversarial resume-parsing coverage (embedded-instruction injection, fabricated facts, evidence-offset tampering) already exists in `test/candidate-profile.test.ts` — matches PRD success criteria #9/#10.
