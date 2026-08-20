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

Keep Greenhouse, Lever, Ashby, and Workday. Workday CXS is a shipped enterprise adapter using unauthenticated structured JSON, bounded pagination, retry/backoff reporting, per-source caching, and paced rotating crawl batches. Prototype Recruitee and Personio next, followed by SmartRecruiters with an authentication-contract probe. Workable has excellent India yield but remains experimental until its anonymous feed has an acceptable stability/usage contract. Exclude Freshteam, Darwinbox, Zoho Recruit, and BambooHR under the current no-HTML/no-required-key constraints.

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

Round 3 draft narrows that follow-up to an evidence-capability decision before another catalog campaign. Probe at most 20 known Lever/Ashby structured boards for a stable provider-owned company-domain field, using independently known positive and conflict controls. Only a successful, specified, and tested structured identity binding may unlock evidence acquisition over at most 200 existing unresolved backlog boards, followed by at most 20 candidate verifications and 12 new-source crawls. Observed provider domains join authoritative company identities only by exact normalized-domain equality (lowercase with a leading `www.` removed); suffix, substring, and name-similarity joins are forbidden. The 200-board step is not a company-dataset scan or new token discovery. If the probe finds no such field, stop: do not repeat the 1/218 redirect trace, launch another token-discovery pass, parse arbitrary career-page HTML, or reinterpret authoritative name/domain datasets as qualifying Lever/Ashby ownership evidence. A cooperative company-owned `.well-known` declaration is the next strong-evidence design option if provider metadata remains unavailable.

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
