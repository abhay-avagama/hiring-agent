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

## 5. Build candidate-driven hidden-job exploration

The user-facing differentiator should be finding relevant public jobs whose titles do not exactly match a conventional query. Add this above the existing matcher rather than creating a second matching implementation.

The exploration workflow should:

1. Derive role families and title aliases only from explicit intent and evidence-backed resume facts.
2. Search the local snapshot across titles, descriptions, skills, seniority, and experience requirements.
3. Preserve country, location, work-mode, exclusion, authorization, education, and experience constraints as hard gates where explicit.
4. Return direct matches, non-obvious/hidden matches, and stretch matches separately, with evidence and keyword scores for every result.
5. Explain which title-family expansion surfaced each non-obvious result.
6. Search immediately, optionally refresh relevant verified sources once according to policy, then rematch once. It must never run source discovery inside the user request.

“Hidden jobs” means public roles that are difficult to discover through exact-title keyword search. It does not mean private, unpublished, authenticated, or access-controlled jobs.

## Revised execution order

1. Specify and implement candidate-driven hidden-job exploration through MCP, reusing the existing evidence matcher.
2. Resume bounded source discovery based on measured provider/employer/eligibility gaps.
3. Research optional transport adapters such as Bright Data or Oxylabs behind the fetch boundary; do not make proxy rotation a correctness dependency.
4. Revisit native PDF/DOCX extraction only when host-side extraction has documented failures.

## Already solid (no action needed)

- `skills/openings/SKILL.md` already matches the PRD's target "thin wrapper" shape — delegates to MCP tools, doesn't reproduce parsing/matching.
- Adversarial resume-parsing coverage (embedded-instruction injection, fabricated facts, evidence-offset tampering) already exists in `test/candidate-profile.test.ts` — matches PRD success criteria #9/#10.
