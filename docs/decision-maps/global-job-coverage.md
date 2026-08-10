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

Use source-partitioned snapshots. Crawl scopes are all sources, a country-focused discovery cohort, or an explicit company list. Successful selected sources replace their partitions; failed selected sources are removed and reported; unselected partitions remain untouched.

## #5: Which Structured Providers And Discovery Channels Can Reach 1,000 Sources?

Blocked by: #2
Type: Research

### Question

Which ATS providers expose stable unauthenticated job data, how can their company tokens be discovered without direct HTML job scraping, and which channels yield strong country-focused source cohorts?

### Answer

Resolved in [structured provider and discovery research](../research/structured-provider-discovery.md).

Keep Greenhouse, Lever, and Ashby. Prototype Recruitee and Personio next, followed by SmartRecruiters with an authentication-contract probe. Workable has excellent India yield but remains experimental until its anonymous feed has an acceptable stability/usage contract. Exclude Freshteam, Darwinbox, Zoho Recruit, BambooHR, and Workday under the current no-HTML/no-required-key constraints.

Use ATS-domain search, career-page redirects, provider directories, community submissions, and independently reverified public datasets in that order; an optional search key only accelerates discovery. The sample found strong lower-bound India yield across Greenhouse, Ashby, Workable, Freshteam, Lever, and SmartRecruiters, but Freshteam cannot currently supply jobs through an approved structured source.

## #6: What Is The Verified Source And Provenance Schema?

Blocked by: #5
Type: Prototype

### Question

What minimal source record supports automatic verification, deduplication, discovery-campaign provenance, health reporting, and future provider adapters without putting country eligibility on companies?

### Answer

Open. Prototype candidate-to-verified transitions and generated catalog output using representative sources from #5.

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

Resolved for the first local format. A versioned JSON snapshot stores one replaceable partition per source plus the last crawl report. Crawls use bounded concurrency; selected successes replace, selected failures disappear and are reported, and unselected partitions remain. Search reads only the snapshot, automatically refreshes after 14 days by default, supports custom freshness, and has a strict offline mode. Large-catalog benchmarking remains follow-up work before a 10,000-source release.

## #9: Can The Verification Pipeline Automatically Maintain The Catalog?

Blocked by: #6, #7, #8
Type: Prototype

### Question

Can discovered candidates be identity-checked, normalized, deduplicated, and automatically promoted or removed with an acceptably low false-positive rate and no mandatory credentials?

### Answer

Open. Report rejected candidates and reasons; never silently import unverified bulk datasets.

## #10: How Do We Reach And Measure The First Country Campaign?

Blocked by: #5, #9
Type: Research

### Question

How many sources must an India-focused campaign discover to produce useful India job coverage, and which provider/channel mix should be expanded next?

### Answer

Open. Begin with 1,000 verified sources, then publish current eligible-job count, distinct-employer count, source success rate, classification-confidence distribution, and discovery yield. Expand toward 10,000 global sources based on observed coverage rather than assuming 1,000 companies currently hire in India.

## #11: Can Workable Become A Trusted Provider?

Blocked by: #5
Type: Research

### Question

Does Workable provide a documented or otherwise acceptable contract for its unauthenticated structured account feed, and what compatibility monitoring would make automatic use responsible?

### Answer

Open. The feed produced valid JSON for 7/7 active India-discovered accounts and has excellent discovery yield, but current public developer documentation emphasizes authenticated APIs. Do not promote it from experimental until this gap is resolved.
