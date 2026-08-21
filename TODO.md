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

## 7. Define “extensive” India coverage before round 2 — draft for review

Decision-map #10 now contains a fixed-baseline target and stopping-criteria draft. The next bounded round proposes moving from 75 to 100 distinct employers with current India-eligible jobs and from 6,177 to 7,500 eligible jobs, including at least five new non-Workday employers. Longer milestones are 150 employers / 12,000 jobs for useful breadth and a provisional 250 employers / 20,000 jobs for an extensive India baseline.

Do not crawl against this draft until it is reviewed. Employer breadth is the primary measure; verified sources, jobs, and ATS tokens are supporting or diagnostic measures. Every round must declare hard campaign caps, retain the coverage quality floors, stop on weak marginal yield or degraded source health, and publish a fixed-reference coverage report afterward.

Approved 2026-08-19 in `ee5a399`. Round 2 started from the fixed 75-employer / 6,177-job baseline with these hard caps: examine at most 200 authoritative company identities, promote at most 50 verification-ready candidates, admit at most 30 sources, and crawl at most 25 newly admitted sources. Stop earlier when the 100-employer / 7,500-job / five-new-non-Workday target is reached, after two comparable 50-identity batches each yield fewer than one newly verified India-eligible employer, or when the documented identity-yield and crawl-health floors fail. Reuse existing registry and company datasets; do not launch a fresh Common Crawl campaign.

Round 2 completed 2026-08-20 at the 25-source crawl cap:

- Examined 30 targeted, authoritative company/source identities; 25 passed independent provider identity and India-job verification. All 25 admitted sources were Greenhouse, satisfying the five-new-non-Workday requirement without another token-discovery campaign.
- All 25 selected crawls succeeded with no throttles. Fixed-reference coverage moved from 79 to 104 verified sources, 48,539 to 50,464 indexed jobs, 6,177 to 6,902 India-eligible jobs, and 75 to 100 distinct eligible employer domains.
- The primary employer-breadth milestone was reached. The 7,500-job supporting target was not: the round stopped honestly at its declared crawl cap, 598 jobs short, rather than expanding scope after seeing the result.
- Quality floors held: 99.04% catalog snapshot coverage, 99.94% explicit confidence among India-eligible jobs, 100% latest-batch success, and every indexed India-cohort partition within the 14-day freshness window.
- The provider mix is now 63 Workday, 38 India-indexed Greenhouse, 1 Lever, and 1 Ashby. This materially reduces Workday concentration, but the milestone-2 requirement for three providers with at least ten eligible employers remains open; Lever/Ashby evidence acquisition is still the limiting factor.

## Already solid (no action needed)

- `skills/openings/SKILL.md` already matches the PRD's target "thin wrapper" shape — delegates to MCP tools, doesn't reproduce parsing/matching.
- Adversarial resume-parsing coverage (embedded-instruction injection, fabricated facts, evidence-offset tampering) already exists in `test/candidate-profile.test.ts` — matches PRD success criteria #9/#10.

## 8. Round 3 — Lever/Ashby identity evidence — closed after phase 1

Round 3 starts from the fixed `2026-08-20T13:00:00.000Z` baseline: 104 verified sources, 103 India-cohort indexed sources, 50,464 indexed jobs, 6,902 India-eligible jobs, and 100 distinct eligible employers. The indexed provider mix is 63 Workday, 38 Greenhouse, 1 Lever, and 1 Ashby.

The campaign objective is provider diversity, not closing the remaining 598-job gap with more Greenhouse or Workday volume. Its desired outcome is to raise either Lever or Ashby from one to at least ten India-eligible employers, which would make three providers contribute at least ten employers. That is a directional target, not authorization to weaken the identity bar when the evidence path does not exist.

Run the campaign in gated phases:

1. **Structured-capability probe, read-only.** Examine at most 20 known Lever/Ashby boards (at most ten per provider) for provider-owned structured organization metadata that includes a mechanically checkable company domain. Include positive controls with independently known company identities and negative/conflict cases. Do not promote candidates or write catalog state during this phase.
2. **Evidence adapter, only if phase 1 succeeds.** If a stable public structured field or endpoint supplies the company domain, specify its canonicalization, conflict handling, payload-version marker, and tests before it becomes `provider_structured_domain` evidence. Then apply the tested adapter to at most 200 existing unresolved Lever/Ashby board leads and join the observed domain to an existing authoritative company identity by exact normalized-domain equality (lowercase with only a leading `www.` removed); suffix, substring, and name-similarity joins are forbidden. This is evidence acquisition over the durable backlog, not new token discovery. A name, board token, job-description URL, search result, DNS record, or arbitrary count of weak matches remains insufficient.
3. **Bounded promotion and crawl.** Only candidates carrying qualifying provider-structured evidence or an already replayable company-owned redirect may enter verification. Verify no more than 20 candidates, admit no more than 12 sources, and crawl no more than 12 newly admitted sources. Every admitted feed must independently contain an India-eligible job.

Hard caps for the entire round: 20 initial capability probes, 200 existing backlog boards checked by a successful tested adapter, 20 verification-ready candidates, 12 admitted sources, and 12 new-source crawls. Do not launch Common Crawl discovery, repeat the already-exhausted conventional career-path trace, scrape career-page HTML, add proxy infrastructure, or admit Greenhouse/Workday sources as part of this round.

Stop immediately when any of these applies:

- none of the 20 structured probes exposes a stable qualifying company-domain field;
- a proposed structured field disagrees with independently known identity controls or cannot be bound to the exact canonical board;
- a new evidence method produces qualifying evidence for less than 5% of its first 50 existing backlog boards;
- verification or crawl health falls below the existing 90% floor, or more than 10% of the batch is affected by throttling/transport failure;
- either the provider-diversity target or any declared cap is reached.

If phase 1 fails, close the round as an evidence-research result and keep the 1,198 raw Ashby tokens parked. The next option should be a cooperative company-owned proof such as a documented `.well-known` board declaration, not weaker inference from public prose.

### Phase 1 result (`2026-08-20`)

The read-only capability probe completed against 20 valid public structured feeds: ten Lever boards and ten Ashby boards, including the independently known MindTickle and Bolna controls. Three additional stale Ashby connection attempts returned non-JSON responses and therefore supplied no payload to examine; replacement tokens were used so that the capped inspection set still contained ten valid Ashby feeds. The complete payload scan covered 576 jobs (350 Lever and 226 Ashby), not a per-board sample.

No payload contained a key whose name indicated company, organization, domain, or website metadata. In particular, none exposed `companyUrl`, `companyWebsite`, `organizationUrl`, `organizationWebsite`, or `website`. Phase 1 therefore failed the declared capability gate. No evidence adapter was implemented, no backlog leads were promoted, no candidates were verified, and no source was admitted or crawled. The catalog, candidate registry, enrichment registry, and snapshots were not modified.

Round 3 is closed under its predeclared stop rule. The 1,198 raw Ashby leads remain parked. Further progress requires a new strong ownership mechanism, with a cooperative company-owned `.well-known` board declaration remaining the next design option; weak name, token, DNS, search-result, or public-prose inference remains forbidden.

Data hygiene was completed separately from round 3 on `2026-08-20` and is not counted as campaign progress. A bounded full-catalog maintenance crawl confirmed `thomsonreuters` was the sole orphaned partition and pruned it through the crawler's normal catalog-sync path. The same run selected only the sole never-indexed verified source, `anthropic`, and indexed it successfully: 484 jobs, including 3 India-eligible jobs, with one attempt, zero throttles, and zero backoff. The resulting coverage report has 104/104 catalog sources indexed, no orphaned partitions, and no never-indexed sources.

## 9. Corpus breadth beyond the big four ATS providers — draft for review

The corpus is currently Workday/Greenhouse/Lever/Ashby only. Decision-map #5 already researched and named the next viable providers — Recruitee and Personio as direct next candidates, SmartRecruiters pending an authentication-contract probe — and already excluded Freshteam, Darwinbox, Zoho Recruit, and BambooHR under the no-HTML/no-required-key constraint. That research has never been executed as a round.

Proposed round 4 remains unapproved until current provider contracts are rechecked and every phase has numeric caps, success criteria, and stop conditions. Once those are written, use the same gated-round discipline as rounds 2 and 3, adapted to a new-provider probe instead of an identity probe:

1. **Adapter feasibility probe, read-only.** For Recruitee and Personio, recheck the current public contract, confirm a stable unauthenticated structured job feed exists, and identify its provider-supplied company-identity field (mirroring how Greenhouse and Workday already supply one). The approved draft must replace this placeholder with an exact board cap per provider; no promotion or catalog writes occur during the probe.
2. **SmartRecruiters authentication-contract check.** Resolve whether its public feed is genuinely keyless in practice, per #5's open item, before treating it as eligible at all.
3. **Bounded promotion and crawl**, only for providers that clear phase 1/2, using the existing verification and quality-floor gates — no new identity standard, just a new adapter.

Do not treat this as authorization to relax the identity bar for any provider, and do not fold Freshteam/Darwinbox/Zoho Recruit/BambooHR back in — #5 already closed those under the current HTML/key constraints.

## 10. Structured `JobPosting` evidence kind — needs research before a round (decision-map #12)

Every current and researched source (existing four ATS providers, plus #9 above) is an ATS-provider feed. Employers who run a custom career page with no ATS behind them — including ones a candidate might otherwise only find via LinkedIn — are invisible to this corpus no matter how many ATS adapters are added. Decision-map #12 asks whether `schema.org JobPosting` JSON-LD can justify a narrow, explicit exception to decision #2: Openings would still fetch an HTML document, but would extract only a standardized company-published structured block rather than infer jobs from prose. This is not yet scoped as a round. Research must first cover URL discovery, SSRF controls, ownership, canonicalization and duplicates, expiry, field reliability, eligibility classification, and whether useful JSON-LD is discoverable from listing pages rather than only unknown detail URLs.

LinkedIn and Indeed themselves remain out of scope: no compliant API for this use case exists without a commercial partnership, which is a different kind of decision than a crawl-engineering task and isn't warranted by a free, local, no-accounts product.

## 11. Candidate-facing coverage transparency — completed (decision-map #13)

Confirmed gap: `skills/openings/SKILL.md` never surfaces what Openings actually covers, and `recommend_jobs` only explains scope *after* a thin result. A candidate searching a country with near-zero coverage learns that only after supplying their resume.

Approved direction: build both pre-resume and in-response transparency from one pure projection over the verified catalog and current snapshot. A lightweight read-only MCP coverage tool lets a host report scope during intent gathering before requesting a resume. `recommend_jobs` also returns the same per-country summary for hosts that go directly to recommendation. Report indexed sources with eligible jobs, eligible-job count, and distinct eligible employer domains; never present discovery-cohort source count as actual country coverage. Extract the shared projection from `coverage report` rather than calling its file-I/O/report generator from the recommender. `SKILL.md` presents the tool-owned result without recalculating it.

Completed with the read-only `get_job_coverage(countries)` MCP tool and a shared pure catalog-plus-snapshot projection. Every `recommend_jobs` response includes the same projection for its requested countries. The maintainer report now uses that projection for indexed sources containing eligible jobs, eligible-job count, and distinct eligible employers; orphaned partitions and discovery cohorts cannot inflate candidate-facing coverage. The skill asks for country intent and presents the tool-owned result before requesting a resume.

## 12. Expand the requirement-vocabulary dictionary — draft for review

`requirementFamilies` and `materialRequirementTerms` in `src/job-matching.ts:266-276` recognize 35 total terms across the entire matching engine (24 skill/language entries + 11 material-requirement phrases). Common stacks are absent entirely — Kafka, GraphQL, Elasticsearch, gRPC, Rust, C++/C#, CI/CD tooling, mobile (Swift/Kotlin), and ML frameworks (PyTorch/TensorFlow) have no entry, so a job requiring any of them can never register a supported requirement, a gap, or a transferable-skill credit for those terms — evidence percentage silently underrepresents real overlap or real gaps whenever a job's actual requirements fall outside this list.

Approved first step: audit the current India-eligible snapshot for frequent unrecognized technical terms in requirement-shaped text. Detection and transferability are separate claims: the detector may recognize a requirement without granting any transferable credit, while transferability requires an explicit, separately reviewed relationship backed by resume facts. Do not force every detected term into the existing four broad families. Implement the model and vocabulary only after the audit result is reviewed, with positive, negative, and cross-family regression tests mirroring `test/job-matching.test.ts`. This is an offline engineering task, not a network campaign.

Audit completed on `2026-08-20`: [requirement vocabulary audit](docs/research/requirement-vocabulary-audit.md). It measured 6,905 India-eligible jobs and 9,396 requirement-shaped clauses. The largest unrecognized low-ambiguity candidates include CI/CD (77 jobs), Linux (46), NoSQL (43), C++ (40), Kafka (35), LLM (34), machine learning (28), and Jenkins (25). The recommended seam is a detection registry plus a separate, default-empty transferability-edge registry; no matcher behavior changed during the audit.

First implementation batch completed: the matcher now owns canonical detection definitions separately from an empty-by-default transferability-edge registry. CI/CD, Linux, NoSQL, C++, Kafka, LLM, machine learning, Jenkins, Spring, and Spring Boot receive exact evidence or honest gaps without cross-technology partial credit. Aliases deduplicate canonically, overlapping spans prefer the longest requirement, and ambiguous matching policy such as Go capitalization/prose exclusions lives with its registry definition. Legacy Java↔Python family-derived partial credit was removed because it had no independently reviewed edge rationale.
