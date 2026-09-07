# Global Job Coverage Decision Map

Goal: grow Openings from a small live-fan-out index into a country-agnostic catalog with at least 1,000 verified sources in the first India-focused discovery campaign, without direct HTML job scraping or required credentials.

## #1: Where Does Geographic Meaning Live?

Blocked by: none
Type: Grilling

### Question

Are countries and remote status properties of companies or jobs?

### Answer

Jobs only. A company has a verified structured source; each job independently carries work mode, eligible countries/regions, remote scope, and confidence. Country coverage is computed from current jobs.

## #2: What May Be Crawled?

Blocked by: none
Type: Grilling

### Question

May Openings extract jobs from arbitrary career-page HTML?

### Answer

No. Career pages and search results may discover an underlying public structured source. Jobs are fetched only from supported unauthenticated structured endpoints. Discovery is keyless by default with an optional maintainer search key.

## #3: Where Does Crawling Run?

Blocked by: #1, #2
Type: Grilling

### Question

Does the first version require scheduled or hosted infrastructure?

### Answer

No. Ship a deterministic local crawler. Users own scheduling. Search automatically refreshes a missing or older-than-threshold snapshot unless offline; the default stale threshold is 14 days and is user-configurable.

## #4: How Are Crawl Results Stored?

Blocked by: #3
Type: Grilling

### Question

How do full and scoped crawls update local data?

### Answer

Use source-partitioned snapshots. Crawl scopes are all sources, a country-focused discovery cohort, or an explicit company list. Successful selected sources replace their partitions. A failed refresh is reported but preserves an existing stale partition; a source with no prior partition remains absent. Unselected partitions remain untouched. Cached rotation selects never-crawled sources first and then the oldest expired sources.

## #5: Which Structured Providers And Discovery Channels Can Reach 1,000 Sources?

Blocked by: #2
Type: Research

### Question

Which ATS providers expose stable unauthenticated job data, how can their company tokens be discovered without direct HTML job scraping, and which channels yield strong country-focused source cohorts?

### Answer

Resolved in [structured provider and discovery research](../research/structured-provider-discovery.md).

Keep Greenhouse, Lever, Ashby, Workday, and Recruitee. Workday CXS is a shipped enterprise adapter using unauthenticated structured JSON, bounded pagination, retry/backoff reporting, per-source caching, and paced rotating crawl batches. Recruitee's documented public Careers Site API is now shipped; its per-job company-owned careers URL provides strong domain evidence. Personio and SmartRecruiters remain parked because their current official contracts require a company ID or API key even where anonymous sample calls may succeed. Workable has excellent India yield but remains experimental until its anonymous feed has an acceptable stability/usage contract. Exclude Freshteam, Darwinbox, Zoho Recruit, and BambooHR under the current no-HTML/no-required-key constraints.

Use ATS-domain search, career-page redirects, provider directories, community submissions, and independently reverified public datasets in that order; an optional search key only accelerates discovery. The sample found strong lower-bound India yield across Greenhouse, Ashby, Workable, Freshteam, Lever, and SmartRecruiters, but Freshteam cannot currently supply jobs through an approved structured source.

## #6: What Is The Verified Source And Provenance Schema?

Blocked by: #5
Type: Prototype

### Question

What minimal source record supports automatic verification, deduplication, discovery-campaign provenance, health reporting, and future provider adapters without putting country eligibility on companies?

### Answer

Partially resolved. Candidate records contain company identity, domain, structured source URL, optional stable slug and discovery cohort, plus channel/reference provenance. Verification resolves a canonical provider/token, validates the live structured payload, checks provider/name/domain identity, and records checked time, content type, payload/adapter version, observed name, evidence type, job count, and canonical URL. The generated catalog is deterministic by slug. Greenhouse exposes authoritative company names; provider-specific identity evidence for normal Lever and Ashby payloads remains open.

## #7: How Should Job Geography Be Classified Across Providers?

Blocked by: #5
Type: Prototype

### Question

How can provider fields and descriptions produce normalized work mode, eligible countries/regions, remote scope, and confidence while avoiding false inclusion from incidental place names or exclusions?

### Answer

Partially resolved in the first crawler slice. Jobs now carry normalized work mode, eligible/excluded countries, eligible regions, and confidence. Country queries honor explicit exclusions before worldwide or regional inference. The classifier still needs a larger provider-neutral corpus before it should be considered complete.

## #8: How Should Partitioned Crawls And Search Behave?

Blocked by: #6, #7
Type: Prototype

### Question

What on-disk partition and manifest shape supports bounded-concurrency crawls, scoped replacement, failure reports, mixed freshness, automatic stale refresh, offline search, and fast local queries?

### Answer

Resolved for the first local format. A versioned JSON snapshot stores one replaceable partition per source plus the last crawl report. Crawls use bounded concurrency; selected successes replace their partitions, failed refreshes preserve existing stale partitions and are reported, and unselected partitions remain. Expansion crawls can skip fresh partitions, prioritize never-crawled then oldest sources, and limit each rotation. Search reads only the snapshot, automatically refreshes after 14 days by default, supports custom freshness, and has a strict offline mode. Large-catalog benchmarking remains follow-up work before a 10,000-source release.

## #9: Can The Verification Pipeline Automatically Maintain The Catalog?

Blocked by: #6, #7, #8
Type: Prototype

### Question

Can discovered candidates be identity-checked, normalized, deduplicated, and automatically promoted or removed with an acceptably low false-positive rate and no mandatory credentials?

### Answer

Resolved for automatic Greenhouse maintenance; partially resolved across the full provider set. `openings sources verify` verifies candidates concurrently without credentials, deterministically deduplicates successful source/company/slug identities, atomically replaces the generated catalog, and reports every rejection with a reason and detail. Greenhouse uses its provider-supplied company name. Workday verifies the public CXS feed and checks its URL-derived tenant identifier against the candidate identity, but the payload does not independently prove ownership of the claimed company domain; stronger Workday ownership evidence remains follow-up work. Lever and Ashby may be promoted when provider-structured identity or a safely replayed company-owned redirect supplies qualifying evidence. Weak name, token, DNS, domain, or search-result matches never accumulate into identity. Previously verified records survive transient endpoint failures. The remaining Lever/Ashby follow-up is acquiring qualifying evidence at scale rather than weakening verification.

Round 3 closed after its read-only capability gate on `2026-08-20`. The complete public structured payloads of ten valid Lever boards and ten valid Ashby boards were inspected, covering 576 jobs (350 Lever and 226 Ashby), including independently known MindTickle and Bolna controls. No payload contained a company-, organization-, domain-, or website-shaped key, including the five identity fields already recognized by verification. Under the predeclared stop rule, no adapter was implemented, no backlog evidence acquisition or candidate verification ran, and no source was admitted or crawled. Catalog and workflow state were unchanged. The 1,198 raw Ashby leads remain parked: do not repeat the 1/218 redirect trace, launch another token-discovery pass, parse arbitrary career-page HTML, or reinterpret authoritative name/domain datasets as qualifying Lever/Ashby ownership evidence. A cooperative company-owned `.well-known` declaration is the next strong-evidence design option.

## #10: How Do We Reach And Measure The First Country Campaign?

Blocked by: #5, #9
Type: Research

### Question

How many sources must an India-focused campaign discover to produce useful India job coverage, and which provider/channel mix should be expanded next?

### Answer

Partially resolved. `coverage report --country CODE` now deterministically measures the current catalog, snapshot, and discovery funnel without network access. It labels global catalog/index/registry metrics separately from country-cohort discovery provenance, computes country eligibility from jobs, and reports distinct eligible employer domains, latest rotation-batch success, provider and confidence distributions, actionable partition freshness, registry yield, and global/country-cohort candidate-promotion yield.

### India coverage targets and stopping criteria — draft

Fixed baseline (`2026-08-19T18:00:00.000Z`): 79 verified sources, 78 India-cohort indexed sources, 48,539 indexed jobs, 6,177 India-eligible jobs, and 75 distinct eligible employer domains. Of the eligible jobs, 6,173 are explicit and 4 inferred. The indexed provider mix is 63 Workday, 13 Greenhouse, 1 Lever, and 1 Ashby.

The primary coverage unit is a **distinct employer with at least one currently indexed India-eligible job**. Verified-source count and raw ATS-token count are inputs, not success measures. Eligible-job count is a supporting measure because a few large employers can otherwise make coverage look broad when it is concentrated.

Use three measured milestones rather than an open-ended source target:

1. **Next bounded round:** reach at least 100 distinct eligible employers (`+25` from baseline) and 7,500 India-eligible jobs, while adding at least five employers outside Workday. This is the next execution target, not a claim that the corpus is extensive.
2. **Useful breadth:** reach at least 150 distinct eligible employers and 12,000 India-eligible jobs, with at least three providers contributing ten or more eligible employers each.
3. **Extensive India baseline:** reach at least 250 distinct eligible employers and 20,000 India-eligible jobs. Reassess this threshold against observed employer density and recommendation recall at the 100- and 150-employer milestones; do not mechanically scale to 1,000 sources.

Every milestone must also preserve these quality floors:

- at least 95% of India-cohort catalog sources have a current snapshot partition;
- at least 99% of India-eligible jobs have explicit eligibility confidence;
- the latest completed crawl batch succeeds for at least 90% of selected sources;
- at least 95% of indexed India-cohort partitions are no older than the configured 14-day freshness window;
- employer growth is reported alongside provider distribution so one enterprise tenant family cannot masquerade as broad coverage.

Stop a bounded expansion round when the first of these conditions occurs:

- the round target is reached;
- two consecutive, comparable seed batches each yield fewer than one newly verified India-eligible employer per 50 identities checked;
- a trace campaign yields qualifying identity evidence for less than 1% of checked company-owned seeds, unless a new evidence source or tracing method is being tested explicitly;
- crawl success drops below 90%, or throttling/transport failures affect more than 10% of the selected batch;
- the campaign reaches its declared cap (maximum seeds checked, verification-ready candidates, or new sources) without explicit approval for another round.

Each campaign must declare those caps before network work begins and publish a fixed-reference coverage report afterward. A fresh Common Crawl campaign is not justified solely by a large unresolved-token backlog. The targets remain scoped to better `recommend_jobs` and `search_jobs` coverage for job seekers; they do not introduce recruiter sourcing, accounts, billing, or data-layer gating.

Round 2 result (`2026-08-20T13:00:00.000Z`): the primary bounded-round target was reached at exactly the declared 25-source crawl cap. Coverage is now 104 verified sources, 103 India-cohort indexed sources, 50,464 indexed jobs, 6,902 India-eligible jobs, and 100 distinct eligible employer domains. Twenty-five new Greenhouse employers supplied the required non-Workday diversification; every selected crawl succeeded without throttling. The 7,500-job supporting target remains unmet by 598 jobs and was not used to justify exceeding the cap. The next campaign must start from this baseline and declare new caps; it must not silently continue round 2.

First measured campaign: the keyless YC company-seed adapter filtered 6,139 public company records to 218 with India locations, probed their published slugs as Greenhouse tokens, found three valid name/domain/source matches (Groww, Able, Raven), and rejected 215 guesses. All three passed independent verification and were promoted automatically; the expanded 12-source India cohort crawled successfully. The resulting snapshot contains 770 jobs, including 118 currently classified as India-eligible across 10 employers; Groww contributed eight, while Able and Raven currently contribute none. That distinction is expected because cohort is discovery provenance and eligibility belongs to jobs. Discovery yield is 1.4%, confirming that reaching 1,000 verified sources requires higher-yield ATS URL feeds/Common Crawl discovery rather than slug guessing alone.

Current expansion baseline committed on 2026-08-19: 75 verified sources, 79 source candidates, and 2,379 durable enrichment leads. An ephemeral local snapshot from the crawl completed at `2026-08-12T03:01:26.629Z` reported 48,657 jobs and 6,106 India-eligible jobs; that snapshot is not committed and these two counts are not yet reproducible from tracked artifacts. Distinct eligible employers, source success rate, provider mix, eligibility confidence, freshness, and discovery yield still need one deterministic reporting command.

## #11: Can Workable Become A Trusted Provider?

Blocked by: #5
Type: Research

### Question

Does Workable provide a documented or otherwise acceptable contract for its unauthenticated structured account feed, and what compatibility monitoring would make automatic use responsible?

### Answer

Open. The feed produced valid JSON for 7/7 active India-discovered accounts and has excellent discovery yield, but current public developer documentation emphasizes authenticated APIs. Do not promote it from experimental until this gap is resolved.

## #12: Can Company-Owned `JobPosting` Structured Data Reach Employers Outside Any Supported ATS?

Blocked by: #2
Type: Research

### Question

Every current and researched source (#5) is an ATS-provider feed. A meaningful share of employers post jobs only through a self-built career page or a channel Openings cannot verify (e.g. LinkedIn), with no ATS behind them at all. Can `schema.org JobPosting` JSON-LD justify a narrow, explicit exception to decision #2, where Openings fetches an HTML document but extracts only a standardized company-published structured block rather than inferring jobs from prose?

### Answer

Research resolved in [company-owned `JobPosting` JSON-LD research](../research/jobposting-jsonld.md). Proceed only to the documented bounded, read-only capability probe; do not build a production adapter or promotion path yet.

JSON-LD is a credible sixth source class, but it is an explicit narrow exception to #2 because extraction still retrieves an HTML container. Only JSON values inside a `JobPosting` script are usable; surrounding prose, links, rendered DOM, JavaScript, and remote JSON-LD contexts remain forbidden. Official guidance places the markup on individual detail pages rather than listings, so approved discovery is limited to company-owned robots and XML sitemaps.

The proposed trust boundary requires authoritative company seeds, same-company HTTPS URLs and redirects, pinned public DNS on every request, robots compliance, strict body/request caps, required job/location/organization fields, exact structured-domain consistency, identifier-or-detail-URL identity, expiry handling, and ATS-first deduplication. Existing deterministic eligibility classification may consume the structured fields and description, with explicit structured geography taking precedence. The approved probe contract fixes a 20-company/200-detail-page/320-request ceiling and explicit yield, quality, health, and stop gates before any HTML GET or persistent workflow write. Its report must preserve the exact ordered identity sample. The first pass measures identifier presence only; persistence requires a later repeat observation.

Phase one stopped safely on `2026-08-21` after the first robots request redirected outside its exact approved origin. No company completed and no JSON-LD yield was measured. The result blocks phase two and production admission; it does not reject the source class. A follow-up needs a separately reviewed, robots-aware transition between origins inside an authoritative company-domain boundary rather than an implicit redirect relaxation.

## #13: How Should A Candidate Learn What Openings Currently Covers?

Blocked by: #10
Type: Grilling

### Question

`recommend_jobs` returns "best available jobs and explains the shortfall" when too few matches exist (PRD, Conditional refresh), and `skills/openings/SKILL.md` presents whatever the tool returns. Neither proactively tells a candidate, before or during their first search, which countries and how many employers are actually covered. Is silence-until-disappointment the right default?

### Answer

Resolved and implemented. One pure catalog-plus-snapshot projection per country reports indexed sources containing eligible jobs, eligible-job count, and distinct eligible employer domains. Discovery-cohort counts remain provenance and are not presented as coverage. The read-only `get_job_coverage` MCP tool exposes the projection before resume collection, every `recommend_jobs` response includes it for requested countries, and the maintainer coverage report shares the same computation without coupling the recommender to report file I/O, registry state, or health diagnostics.

## #14: How Should Requirement Detection And Transferability Evolve?

Blocked by: none
Type: Prototype

### Question

The matcher recognizes only a small fixed technical vocabulary. How can Openings detect more real job requirements without manufacturing transferable evidence between technologies that merely share a broad category?

### Answer

Resolved for the first implementation batch and measured in the [requirement vocabulary audit](../research/requirement-vocabulary-audit.md). Requirement detection and transferable credit are separate registries. CI/CD, Linux, NoSQL, C++, Kafka, LLM, machine learning, Jenkins, Spring, and Spring Boot now receive exact evidence or honest gaps. Transferability is empty by default; the previous Java↔Python family-derived credit was removed because no independently reviewed edge and rationale authorized it. Canonical aliases deduplicate, overlapping spans prefer the longest match, and per-definition matching policy contains ambiguity controls such as Go capitalization and prose-idiom exclusions. Future vocabulary can extend detection without changing transferability; every future edge requires a durable rationale and public-behavior tests.

## #15: How Should Openings Record Job History Without Disrupting Live Search?

Blocked by: #6, #8
Type: Prototype

### Question

`crawler.ts` replaces a source's entire partition on every successful crawl (`partitions[source.slug] = { fetchedAt, jobs }`); a job absent from the new result simply disappears with no record it ever existed. This makes lifecycle questions — how long a role stayed open, when an employer stopped hiring for it, hiring-trend or skill-recurrence analysis over time — structurally unanswerable today, and blocks any future decision (including a possible commercial jobs API, tracked separately) that would need historical data. How does Openings start recording job history without touching the read path candidates depend on today, and without abandoning the auditability this project has built everything else around?

### Answer

**Additive first, not a replacement.** Snapshot replacement (the live-serving path) stays exactly as today: a partition is replaced only on complete crawl success, a failed or partial crawl preserves the existing partition, unchanged. History ingestion is a second, independent consumer of a **crawler result envelope**, produced once per **scheduled** crawl (`CrawlRun`), after its retry cycle of one or more `CrawlAttempt`s concludes — not once per attempt. The envelope is a **discriminated union on `outcome`** (the concluding attempt's outcome), so an invalid combination is structurally unrepresentable rather than merely prose-forbidden:
- `{ outcome: "success"; complete: true | false; jobs: Job[]; scope; runId; attempts: CrawlAttempt[] }` — the retry cycle ended in a finished crawl; `complete` still distinguishes a provably-exhaustive result (`true`) from one that finished its request budget without proving exhaustiveness (`false`).
- `{ outcome: "partial"; complete: false; jobs: Job[]; scope; runId; attempts: CrawlAttempt[] }` — stopped early by design (e.g. a bounded-round cap); `complete` is always `false` — a partial run knows by construction that it didn't finish, it is never `true` and never the migration-only `unknown`.
- `{ outcome: "failure"; complete: false; jobs: []; scope; runId; attempts: CrawlAttempt[] }` — no usable data; `jobs` is always empty and `complete` is always `false`.

`attempts` carries every `CrawlAttempt` in this run's retry cycle (outcome and timestamps each), so a crash between attempts doesn't lose history that only ever existed in memory before the single, end-of-cycle outbox write.

Snapshot replacement reads only `outcome === "success" && complete === true` from that envelope, same rule as today; history ingestion reads the whole envelope, every time, including partial and failed attempts (see below for what each outcome may and may not establish). Only that one combination — `success` and `complete: true` — may ever authorize a removal inference; the type itself rules out the two combinations that would otherwise need a runtime check (`partial` claiming `true`, `failure` carrying observations), rather than relying on every call site remembering not to construct them. This resolves what the first draft's "after a successful crawl" line got wrong: it implied history-writing was gated on success, which conflicts with partial crawls needing to record what they did see. `recommend_jobs` and `search_jobs` keep reading the existing snapshot, unchanged, until a later, separate decision demonstrates the historical store can reconstruct the same current-state view (parity) — this decision authorizes building the store, not switching what serves candidates.

**Storage: SQLite locally, JSON stays JSON.** `data/companies.json`, `data/enrichment-leads.json`, and `data/source-candidates.json` remain exactly what they are — diffable, git-committed, human-reviewable. The new observation history is high-volume and append-only in a way flat JSON files handle poorly at scale, so it lives in a gitignored SQLite database under `.openings/` (e.g. `.openings/job-history.db`), consistent with `.openings/` already being this project's local, non-committed state directory. No Postgres, no hosted database, no hosted backend in this phase. Because the database itself isn't git-diffable, a deterministic export/report command (mirroring `coverage report --as-of`'s fixed-timestamp determinism) is a required deliverable, not an optional nicety — it's the only way this store stays auditable the way every other artifact in this project already is.

**Employer identity may be shared; source verification may not — and only for company-board Sources, which is a narrower claim than the first draft made.** A company-owned ATS board (Greenhouse/Lever/Ashby/Workday/Recruitee per-company tokens — today's existing model) verifies one Employer. That verified Employer may be linked from more than one such board, but an existing verified Employer never substitutes for a new board's own identity proof: every company-board Source still independently passes the full existing bar (`structured_domain_link`, `provider_company_name`, `provider_tenant`, or a safely replayed company-owned redirect) against its own live payload before admission, exactly as today. **This does not extend to aggregate feeds** (Adzuna, Jooble, and the other TODO §15 candidates) — see the `Provider` split below; an aggregate feed spans many employers by construction and structurally cannot pass company-board ownership verification, because there is no single company to verify at the feed level.

**`Employer` records preserve the evidence kind and strength that established them, not a flattened boolean.** `structured_domain_link` (live-verified against a structured payload), `provider_company_name` (a provider's own declared name), `provider_tenant` (Workday's URL-derived tenant, which decision #9 already notes does not independently prove domain ownership), and `company_redirect` are not equally strong. An Employer record carries its specific evidence kind; anything that reuses an Employer's identity elsewhere must weigh that specific strength, not treat every catalog domain as equivalently assured.

**Entities**, extending rather than replacing the existing `Job`/`Company` types:

- `Provider` — the technical integration itself, split by kind: `single_employer` (a company-owned ATS board — today's model, unchanged) or `multi_employer_aggregate` (a third-party feed spanning many employers, per the TODO §15 research candidates — Adzuna, Jooble, The Muse, Artificial Intelligence Jobs, AI Dev Jobs). This is the fix for the first draft's conflation: a `Source` is now specifically a `single_employer` Provider instance bound to one verified Employer. A `multi_employer_aggregate` Provider has no Source-level Employer at all.
- `Scope` — the actual origin-relation table, so `CrawlRun → origin` is a real foreign key rather than a promise about an abstract concept. One row per distinct thing a `CrawlRun` can be run against: for `single_employer` Providers, `sourceId` alone (trivially one board, matching today). For `multi_employer_aggregate` Providers, `(providerId, scopeVersion, scopeHash)`, where `scopeHash` is a canonical hash of normalized query parameters (query, country, page/partition range) — versioned and normalized so scope equality stays stable as an aggregate adapter's own query shape evolves over time, rather than two differently-serialized-but-semantically-identical queries silently being treated as different scopes (or the reverse). `CrawlRun.scopeId` always points here. **`Job` does not carry a matching FK the same way** — see `Job`, below: a `single_employer` Job's scope is reached indirectly, through its own direct `sourceId`; an aggregate Job has no origin FK of any kind, single or otherwise.
- `EmployerClaim` — for jobs from a `multi_employer_aggregate` Provider only: the employer name/domain that specific job record asserts, carried per-observation, not per-feed. Defaults to unverified/low-confidence; never promotable to a verified `Employer` link, and never merged into `data/companies.json`, without independent per-record verification — there is no feed-level shortcut.
- `CrawlRun` — one row per **scheduled crawl** (for the prototype, one per source per day — see below), not one row per transport-level try. Deterministic `runId` (derived from `scopeId` + the scheduled day, so a retried write reproduces the same id), `startedAt`/`finishedAt` spanning the whole retry cycle, a final `outcome: success | failure | partial`, `complete: true | false | unknown` (**tri-state, not boolean** — migration seeds `unknown`, a partial run that knowingly stopped early is `false`, and only a run that provably enumerated its entire scope is `true`; only literal `true` may ever authorize an absence/removal inference), `scopeId`, and the observed job-id set for that run. This final state is the *last* `CrawlAttempt`'s result, below — absence, completeness, failure, and "what was actually seen this run" are properties of the run's concluding attempt, not of any individual job. Absence and completeness only mean anything when compared **between two runs of the identical `scopeId`** — comparing across different scopes (a US query against an EU query, or two different aggregate queries that happen to overlap) cannot establish removal for either.
- `CrawlAttempt` — one row per actual transport-level try within a `CrawlRun`'s retry cycle (`runId` FK, `attemptNumber` starting at 1, `startedAt`/`finishedAt`, its own `outcome: success | failure | partial`). **This is the persisted source of truth for retry/attempt counts** — `attemptCount` is `COUNT(CrawlAttempt WHERE runId = ...)`, always derived from these rows, never a separately-maintained integer that could drift from them, the same discipline already applied to `JobObservation`'s scope. Only a `failure` attempt triggers the next attempt, up to the prototype's 2-retry cap (3 total tries); a `success` or `partial` attempt ends the cycle immediately — a `partial` result is a legitimate by-design stopping point (a bounded-round cap was reached), not a defect to retry away. **Adapter-internal HTTP retries do not get their own `CrawlAttempt` row**: transient-error retry logic living inside one adapter call (e.g. one transport-layer 500 retried transparently before the adapter returns) is that adapter's own implementation detail and produces one logical result, exactly as it does today; a new `CrawlAttempt` exists only for a whole fresh adapter invocation after a prior one concluded in outright `failure`. The crawler result envelope is emitted to the outbox exactly **once per `CrawlRun`, after its retry cycle concludes** — not once per attempt — and carries the full `attempts` list (each attempt's outcome and timestamps) alongside the run's final `outcome`/`complete`/`jobs`, so a crash mid-retry-cycle doesn't silently lose attempt history that only ever existed in memory.
- `Job` — stable normalized identity. A `Job` sourced from a `single_employer` Provider carries a direct `sourceId` FK to its one `Source`, and its `Scope` follows trivially (`Scope WHERE sourceId = Job.sourceId`, the identical value — no separate column needed). A `Job` sourced from a `multi_employer_aggregate` Provider has **no stored origin FK at all**: it may be observed through **more than one `Scope`** (the same real posting can match more than one query), and which scopes is a *derived* fact, never a stored one — `SELECT DISTINCT scopeId` over that job's `JobObservation`s, joined `runId → CrawlRun.scopeId`, the same join-don't-store discipline already applied to `JobObservation` itself. No separate membership table is introduced for this: the observations already are the membership record, and a table restating what they already prove would be one more place for the two to silently disagree — see the per-scope derivation model below for how `Availability`/`lastCheckedAt` consume this.
- `JobObservation` — an immutable record of what one `CrawlRun` (and therefore one `Scope`) reported for one job. References `runId` rather than duplicating its metadata — scope in particular is **derived by joining `runId → CrawlRun.scopeId`, never stored redundantly as a second `scopeId` column on the observation itself**, so the two can never disagree about which scope produced the observation. Unique on `(runId, jobId)`. Written once, never edited; a correction is a new observation, not a mutation — the same discipline `CandidateFact` already holds for resumes.
- `Employer` — verified identity (company-board Sources only, see above), carrying its evidence kind and strength.
- `Availability` — `active | expired | removed | unknown`. **Never stored, always derived, and derived per `(jobId, scopeId)` first, then combined into one job-level result.** Per-scope derivation walks that `(jobId, scopeId)` pair's `CrawlRun`s backward from most recent, inside the existing 14-day freshness window, looking for the newest **authoritative** signal about *this specific job* — not simply the newest run. A run is authoritative for a job only if it actually says something about that job: either it contains a positive `JobObservation` for it, or it is `complete: true` and thereby proves absence by omission. A failed run, or a partial run that simply didn't happen to include the job, is silent about it and is skipped — silence has no authority to override a still-fresh positive or complete-absence verdict from an earlier run, even though the silent run is chronologically newer; skipped runs still advance `lastCheckedAt` (below), just never `Availability`. If no authoritative run exists inside the freshness window, that scope's contribution is `unknown`. Only *within the one selected authoritative run's own evidence* does precedence apply to resolve a contemporaneous conflict — e.g. the job is both present and carries a passed expiry signal in the very same run: `removed` (the run is `complete: true` and the job is absent from it) beats `expired` (present, but the provider's own stated close date has passed) beats `active` (present, no contrary signal). This ordering never compares evidence *across* runs — reactivation stays automatic because a later *authoritative* `active` observation is simply the new most-recent authoritative run and wins on recency, never because it out-ranks an old `removed` by signal strength. **Combining scopes for a job-level result**: if any contributing scope resolves to `active`, the job-level result is `active` — absence or removal inferred in one scope must never override presence still confirmed in another, since a scope's absence-inference is inherently bounded to that scope's own query. Otherwise, the strongest non-`active` result among scopes applies (`removed` before `expired` before `unknown`). A `single_employer` job has exactly one scope, so this reduces to the per-scope rule directly, unchanged from a single-source view.
- `Provenance` — source URL, retrieval time, provider, and the redistribution status below.
- `Eligibility` — the existing job-level country/remote eligibility and confidence fields, carried over unchanged.
- `Content Rights` — `internal-use | publicly-redistributable | licensed | unresolved`, at the `Provider` level (and, for aggregate feeds, potentially overridden per-record if a feed mixes rights). Every Provider defaults to `unresolved` on creation; nothing else may be set without an explicit, reviewed finding from the redistribution-rights research already scoped as step 1 of TODO §15 (not decision #12, which is the unrelated `JobPosting` JSON-LD probe — the first draft cited this wrong). Resolved per-record in the schema, not bolted on as an API-layer afterthought later.

**`lastCheckedAt` follows the same per-scope-then-combine shape as `Availability`, and is never a stored field.** Per scope: `lastCheckedAt(job, scope) = most recent CrawlRun.finishedAt where CrawlRun.scopeId = scope.id`, computed over *every* run in that window regardless of authority — a failed or silent-partial run still proves the scope was checked, even though it can't move `Availability`. Job-level: the maximum across every scope that job has ever been observed through. A `single_employer` job again reduces to the single-scope case, matching today's mental model exactly.

**A `scopeVersion` bump deliberately creates a new `Scope`; the predecessor is left to age out, not migrated.** When an aggregate adapter's own query shape changes enough to warrant a new `scopeVersion`, that produces a new `(providerId, scopeVersion, scopeHash)` row — a new `Scope` with its own fresh history, no jobs carried over. The predecessor scope simply stops receiving new `CrawlRun`s; every job that was only ever observed through it ages to `unknown` via the same 14-day freshness mechanism everything else already uses. No alias or migration entity is needed: `Availability` is already always re-derived from scratch per scope, so an abandoned scope quietly going `unknown` is that same mechanism doing its job, not a gap. The alternative — an explicit alias table asserting that jobs observed under the old scope carry continuity into the new one — was considered and rejected: it requires judging two differently-shaped queries "the same underlying scope" for continuity purposes, exactly the kind of implicit judgment call `scopeHash` normalization exists to avoid. If that continuity is ever genuinely needed, it should be a deliberate, separately reviewed decision made when a real case demands it, not default behavior baked in now on spec.

**Complete-feed vs. partial-feed semantics are the load-bearing safety property, and partial crawls are not all-or-nothing.** A `removed` determination is only valid evidence if the `CrawlRun` that omitted the job was `complete: true` — full Workday pagination finished, a Greenhouse/Lever/Ashby/Recruitee response fully parsed without truncation or transport error, or (for an aggregate scope) the query provably exhausted. Neither `false` nor `unknown` completeness may ever drive a `removed` transition. But an incomplete run is not therefore useless: **whatever jobs a partial or otherwise-incomplete run did successfully return are recorded as genuine positive `JobObservation`s** — those jobs really were seen and their `lastSeenAt` genuinely advances, and per the per-scope-then-combine rule above, a positive observation from an incomplete run still contributes toward `active` at the job level even if a different, complete run of a different scope says otherwise. A fully failed run (no data at all) contributes no observations and only advances the `CrawlRun` record itself, exactly mirroring the existing crawler's "a failed refresh preserves the existing stale partition and reports the failure."

**Timestamps, per job identity**: `firstSeenAt` (earliest observation), `lastSeenAt` (most recent observation where the job was actually present) — both stored on `Job`; `lastCheckedAt` is derived as above, not stored redundantly on `Job`.

**Stable identity and cross-source deduplication.** Within one company-board Source, the existing per-provider job id (already used as `Job.id` today, e.g. `greenhouse:capco:7730535`) is the authoritative, always-trusted identity — no new dedup logic needed there. Recognizing the *same real-world opening* posted through a company-board Source and an aggregate Provider's `EmployerClaim`, or through two ATS platforms, is a separate, lower-confidence, optional pass: normalized employer + normalized title + normalized location plus a description-similarity check, with any ambiguous case quarantined rather than silently merged — the same discipline round 5 already applied to conflicting Recruitee identity joins. Cross-source consolidation is not required for this store to be useful and should not block it.

**Migration from the current snapshot must not invent history — including inventing completeness.** `.openings/snapshot.json` only has current state — no history exists to backfill, and today's snapshot format carries no `complete` signal at all, so nothing about "this partition is currently live" is actual proof that its last crawl was a provably complete enumeration. A one-time migration creates exactly one `CrawlRun` per currently-indexed source, marked `complete: unknown` (not `true`) unless some other verifiable artifact proves completeness, and one `JobObservation` per currently-present job, with `firstSeenAt = lastSeenAt = partition.fetchedAt` — never a fabricated earlier `firstSeenAt`, and never a fabricated completeness claim. This is consistent with the rest of the design, not a loss: an `unknown`-completeness migrated run can still establish positive observations, it just can't be used later to infer `removed` for anything it didn't include, exactly the same restriction any other incomplete run has.

**Cross-store write safety needs a durable payload written before either consumer touches it, not only a deterministic key.** A deterministic `runId` prevents duplicate rows on retry; it does not preserve data that only ever existed in memory. **Ordering, explicit**: the moment a crawl attempt finishes, the crawler result envelope is durably written to a local, atomic **outbox** file under `.openings/` (one file per pending run, using the same atomic-write discipline `atomicJson` already uses elsewhere in this codebase) — this happens *before either* snapshot publication or SQLite ingestion begins, not merely before SQLite. If durability happened only ahead of the SQLite write, a crash between "crawl finished" and "envelope durably spooled" would still lose the run entirely even though the live snapshot might already have been updated from the same in-memory result — the ordering guarantee is worthless unless it's the very first thing that happens. **"Durable" here means process-crash safety, matching exactly what `atomicJson` already provides at every other call site in this codebase (`writeFile` to a temp path, then `rename`) — not power-loss safety.** `atomicJson` never calls `fsync` on the file or its parent directory anywhere it's used today, so a whole-machine power loss between `rename` returning and the OS actually flushing that metadata to disk could still lose an outbox entry; this design accepts that exposure rather than introducing a stronger durability primitive nothing else in the project uses, since the failure mode being defended against here is a crashed/restarted process, not a power outage. If a future decision needs power-loss safety specifically, that's a separate, explicitly-scoped change to `atomicJson` itself (adding `fsync` on the file descriptor and the parent directory before `rename`/after it), not something this decision should special-case only for the outbox.

Both consumers then read from the durable outbox entry, not from the original in-memory result. **The outbox entry is retained until both consumers reach a terminal state, not just SQLite**: it carries two independent acknowledgment fields, `sqliteAck` and `snapshotAck`, each written only once that consumer is actually done — `sqliteAck` when the SQLite transaction commits; `snapshotAck` when the snapshot is published (the existing `outcome === "success" && complete === true` case) or, for every other outcome, explicitly set to a `no-op` marker rather than left unset, since a `partial`/`failure`/incomplete envelope was never going to touch the live snapshot and must say so rather than looking like unfinished work forever. **Acknowledgment updates are serialized through this codebase's existing `withFileLock` (`src/file-lock.ts`), the same primitive `enrichment-registry.ts` and `company-seeds.ts` already use for exactly this class of problem** — reading two unacknowledged fields, updating one, and possibly deleting the entry are not three independent steps but one critical section: each consumer acquires the lock on the outbox entry's path, reads the current entry, sets its own ack field, writes the entry back, and — inside that same locked section — deletes the entry if both acks are now present, before releasing the lock. This closes the lost-update race a plain read-then-write would have: two consumers acknowledging at nearly the same moment serialize through the lock instead of both reading the same pre-ack state and each overwriting the other's update. `runId` stays deterministic (`scopeId` + attempt timestamp) so a retried write reproduces the same id; the `(runId, jobId)` uniqueness constraint on `JobObservation` makes replay idempotent; the full write for one run (its `CrawlRun` row plus all its `JobObservation` rows) happens inside one SQLite transaction, so a run is either fully recorded or not recorded at all. **The live snapshot must remain servable even if history persistence fails**: a history-ingestion failure is reported distinctly from crawl success/failure, never folded into it, and never blocks or rolls back snapshot publication. A crash-surviving outbox entry is exactly what a later reconciliation pass replays.

**Retention is defined by data class, not one number, and a tombstone cannot claim to hold a "final Availability."** Bulk raw content (full observation payloads, e.g. description text) is the removable class — it can be deleted or compacted after a bounded window. What survives deletion is **not** a stored "final Availability" — `Availability` is declared derived and freshness-sensitive above, so a value frozen at deletion time and never re-evaluated is a different kind of thing and must be labeled as one. The durable tombstone instead retains: `Job` identity, `firstSeenAt`/`lastSeenAt`, the `Employer` link **or, for aggregate-sourced jobs, the original `EmployerClaim` — never silently upgraded to look like a verified Employer link once the raw distinguishing detail is gone** — and an explicitly labeled **projection**: "as of [timestamp], based on evidence through [last considered run], the derived status was X," never presented as current. This keeps trend/count analysis working without raw retention while being honest that a tombstoned status is a historical snapshot, not a live fact. Rights-driven deletion is a separate trigger from age-based retention: if a Provider's `Content Rights` determination later requires purging, that purge is scoped to records from that specific Provider, not a global sweep, and still leaves a tombstone unless the rights finding requires removing that too. Deterministic exports only ever surface what current retention/rights state actually permits.

**The retention number needs a bounded measurement phase, not "before implementation" and not "after the store exists" as separately worded elsewhere** — those two framings contradict each other, since actual observation volume cannot be measured before observations exist. The resolution is a real, named prototype, not an open-ended placeholder:

- **Duration and schedule**: exactly **14 consecutive calendar days**, matching the existing freshness window. Each of the 5 sources gets **exactly one scheduled `CrawlRun` per calendar day** — never zero and never more than one, so the daily growth grid stays unambiguous. Within that one `CrawlRun`, a `failure` `CrawlAttempt` may be retried with a fresh attempt **up to 2 times, same-day only, immediately following the failure** (3 `CrawlAttempt` rows at most) — never deferred to the next day's slot, never a second scheduled `CrawlRun`. The `CrawlRun`'s recorded outcome is its concluding attempt's outcome; if every attempt fails, that day's one `CrawlRun` is `failure`, not zero and not multiple, and still carries all 3 `CrawlAttempt` rows as its persisted retry history.
- **Sources**: a **named subset of 5 already-verified `single_employer` Sources, one per distinct ATS adapter currently in the catalog** — `abb` (Workday), `anthropic` (Greenhouse), `bolna` (Ashby), `mindtickle` (Lever), `transperfect` (Recruitee). This exercises every adapter's real completeness/pagination behavior once rather than one adapter's quirks five times. `multi_employer_aggregate` Providers are explicitly excluded from this phase — none is approved yet (blocked on TODO §15 step 1) — so this measures single-scope growth only; extending to aggregate scopes is a follow-up once that research lands.
- **Tombstone/projection mechanics are verified separately, by a controlled synthetic transition — not by waiting on a real one.** Before or alongside the 14 live days, one disposable synthetic `Job` is seeded with two synthetic `CrawlRun`s against a throwaway scope (clearly tagged synthetic and excluded from every real-source count below): one observing it `active`, a second, later one proving it `removed` (`complete: true`, job absent). This deterministically exercises the tombstone/projection code path on demand, independent of whether any real source happens to remove a job during the window.
- **Expected outputs**, produced by the deterministic export/report command below, computed over the 5 real sources only: total `CrawlRun` and `JobObservation` row counts per day, day-over-day growth rate, raw SQLite file size over the 14 days, `CrawlAttempt` counts per `CrawlRun` (to see how much of the 3-attempt budget real flakiness actually consumes), and the count of real `removed`/`expired` transitions observed, if any — itself a measured output, not a precondition (see below).
- **Success criterion**: all 5 sources complete their scheduled daily attempt (subject to the retry rule) for the full 14 days, growth/reconciliation numbers are collected regardless of whether any lifecycle transition occurred, and the synthetic tombstone/projection test (above) passes. **Real transition incidence does not gate success**: if zero natural `removed`/`expired` transitions occur across all 5 sources during the 14 days, that specific measurement is recorded as `insufficient_evidence` — a valid, informative result (this source set's real turnover is lower than 14 days can observe) — not a prototype failure and not grounds for extending or restarting the clock on its own. The retention window is set from the measured growth rate once the 14 days and the synthetic test are both complete, whatever the real-transition count turned out to be.
- **Stop/abort criterion**: if outbox reconciliation fails to converge (an entry stuck without both acknowledgments) on 3 or more distinct occasions, or any single source has 3 or more consecutive days where its `CrawlRun` (after its `CrawlAttempt` retries) ends in `failure`, the prototype halts, the cause gets fixed, and the 14-day clock restarts from zero — a run with unexplained gaps can't produce a trustworthy growth number. This is a different condition from `insufficient_evidence` above: gaps in *checking* are an abort; the absence of a *transition* to observe, once checking succeeded every day, is a valid measured result.

TODO §17 states this phase explicitly as its own prerequisite.

**Implementation contract, for whoever builds this:** the SQLite schema needs an explicit version number and forward migrations from day one, foreign key constraints enabled and enforced. The complete core set: `JobObservation.runId`→`CrawlRun`; `JobObservation.jobId`→`Job`; `CrawlAttempt.runId`→`CrawlRun`; `CrawlRun.scopeId`→`Scope`; `EmployerClaim.jobObservationId`→`JobObservation`; `Job.sourceId`→`Source`, nullable, populated only for `single_employer`-sourced Jobs (never populated for aggregate-sourced ones, which have no origin FK at all — see `Job`, above); `Scope.sourceId`→`Source` and `Scope.providerId`→`Provider`, each nullable; `Source.providerId`→`Provider`; `Source.employerId`→`Employer`. `Scope` is the real, concretely-defined table above that makes these FKs possible, not an abstract "origin" promised without a target. **`JobObservation` deliberately has no `scopeId` column of its own** — a second, independently-writable copy of scope on the observation could drift from the run it claims to belong to for no benefit, since every query that needs an observation's scope already has `runId` to join through to `CrawlRun.scopeId`.

**Scope identity needs real unique indexes, not just an FK shape, or one board or one aggregate query can acquire multiple competing `Scope` rows.** Two indexes, matching the entity's own either/or: a partial unique index on `sourceId` (`CREATE UNIQUE INDEX ... ON Scope(sourceId) WHERE sourceId IS NOT NULL`, since SQLite treats `NULL` as distinct from itself in a plain unique index, so the aggregate rows with `sourceId IS NULL` would otherwise be unconstrained and *would* collide against each other under a naive unique index); and a unique index on `(providerId, scopeVersion, scopeHash)` for the aggregate rows. Together these are what actually stop a second insert from silently creating a duplicate `Scope` for the same board or the same aggregate query — the FK to `Scope` only constrains what *points at* a row, not how many rows can exist for the same real-world origin.

**Provider-kind coherence is enforced with triggers, not `CHECK`, because SQLite's `CHECK` constraints cannot reference another table.** Two `BEFORE INSERT`/`BEFORE UPDATE` triggers on `Scope`: one rejects a row where `sourceId IS NOT NULL` unless the `Source` it points to belongs to a `single_employer` `Provider`; the other rejects a row where `providerId IS NOT NULL` unless that `Provider` is `multi_employer_aggregate`. A third trigger enforces **"failure runs cannot own observations"** the same way, on `JobObservation`: `BEFORE INSERT`, reject if the referenced `CrawlRun.outcome = 'failure'`. All three are cross-table invariants a single-row `CHECK` structurally cannot express, so triggers are the one consistent mechanism for this class of rule, while `CHECK` stays for everything genuinely single-row.

**`CHECK` constraints apply only to columns that are actually stored, and now directly mirror the envelope's discriminated union rather than restating it loosely in prose:** on `CrawlRun`, `CHECK ((complete != 'true' OR outcome = 'success') AND (outcome = 'success' OR complete = 'false'))` — read together, this says `complete = 'true'` requires `outcome = 'success'`, and `outcome IN ('partial', 'failure')` requires `complete = 'false'`, exactly the three envelope shapes above, encoded as one constraint instead of three separate prose rules that could drift apart. **`success` paired with `unknown` remains explicitly allowed** by this `CHECK` (neither clause fires when `complete = 'unknown'`), since that combination is exactly what migration seeds for backfilled runs with no completeness evidence — a real, intentional exception, not a gap. `Provider.contentRights` and `Scope`'s exactly-one-of-`sourceId`/`providerId` constraint (`CHECK ((sourceId IS NULL) != (providerId IS NULL))`) round out the columns that qualify. **`Availability` does not** — it's declared derived and never stored, so there is no column to constrain; a `CHECK` on it would contradict the design. If the tombstone's labeled historical projection (see retention, below) is implemented as a stored value, it must live in its own distinctly-named column (e.g. `Tombstone.projectedAvailability`, never reusing the name `Availability`), and that column is what a `CHECK` constraint would apply to instead.

**Explicit non-goals for this decision:** no hosted API, no accounts, no billing, no resume storage of any kind (this store is jobs-only; resumes remain entirely outside it, per the existing stateless MCP boundary), and no change to what `recommend_jobs`/`search_jobs` read yet. The eventual commercial jobs-API decision may depend on this store existing, but is deliberately a separate decision, made later, on its own terms.
