# Openings

Openings is a public, read-only index of real company job boards that agents can search without accounts or provider-owned credentials.

## Language

**Verified company source**:
A company whose public job source is reachable and belongs to the identified company. Verification does not assign markets or hiring eligibility to the company.
_Avoid_: Verified India company, India company

**India coverage target**:
The first country-focused discovery campaign, initially targeting at least 1,000 verified company sources likely to improve India job coverage. India is a parameter, not a company classification or a special crawler mode.
_Avoid_: India company index, permanent India market tag

**Job eligibility**:
The countries or regions from which an applicant may take a specific job. Eligibility belongs to the job, never to the company.
_Avoid_: Company market, India-hiring company

**Country filter**:
An ISO country code used to select jobs whose eligibility includes that country. The same interface applies to India and every other country.
_Avoid_: India mode, company country

**Country-focused discovery campaign**:
A temporary effort to discover company sources likely to improve job coverage for a selected country. Campaign provenance may be recorded, but it does not classify the company.
_Avoid_: Country-specific company index

**Work mode**:
The job's working arrangement: remote, hybrid, onsite, or unknown. Work mode is independent of geographic eligibility.
_Avoid_: Location, country, market

**Remote scope**:
The geographic constraint on a remote job: country-limited, region-limited, worldwide, or unknown.
_Avoid_: Remote eligibility

**Eligibility confidence**:
Whether a job's geographic eligibility is explicit, inferred, or unknown. Remote jobs with unknown eligibility may be surfaced separately but are not represented as confirmed India jobs.
_Avoid_: Company confidence

**Job source**:
A public, unauthenticated structured endpoint from which Openings reads a company's current roles.
_Avoid_: Scraped page, listing site

**Enterprise provider adapter**:
A provider integration, such as Workday CXS, that paginates a public structured job API. Provider scale does not weaken source identity checks or permit career-page HTML extraction.
_Avoid_: Enterprise scraper, trusted company bypass

**Local crawl**:
An explicitly invoked, keyless run that fetches jobs from verified structured sources and writes a static local job snapshot. It crawls jobs rather than companies, never extracts jobs from arbitrary career-page HTML, and requires no scheduled infrastructure.
_Avoid_: Web scraper, hosted crawler, scheduled backend

**Crawl schedule**:
The user-owned mechanism and cadence for invoking local crawls, whether manual, cron-based, CI-based, or agent-driven. Openings provides the crawl command but no scheduler.
_Avoid_: Openings scheduler, mandatory cadence

**Crawl scope**:
The verified sources selected for one crawl: the entire catalog, a country-focused discovery cohort, or an explicit company list. Scope controls which sources are fetched, not how returned jobs are classified.
_Avoid_: Country eligibility, company market

**Job snapshot**:
A locally generated, timestamped collection of normalized and classified jobs used for fast searches without contacting every source per query.
_Avoid_: Hosted database, live fan-out search

**Stale threshold**:
The user-configurable maximum age of a local job snapshot before it is considered stale. The default is 14 days.
_Avoid_: Source expiry, company freshness

**Offline search**:
A search that uses the current local snapshot regardless of age and performs no refresh. Without the offline override, a stale or missing snapshot is rebuilt automatically before search.
_Avoid_: Live search, stale threshold

**Crawl failure**:
A source that cannot be fetched or normalized during a local crawl. Its jobs are omitted from the new snapshot and the source-level failure is included in the crawl report; stale jobs are not retained.
_Avoid_: Empty board, stale fallback

**Career page**:
A company-owned human-facing jobs page used only to discover or confirm its underlying job source. Openings does not extract jobs from the page's HTML.
_Avoid_: Job source

**Source discovery**:
The process of resolving a company or career page to a supported public structured job source before verification.
_Avoid_: Career-page scraping, job scraping

**Discovery ladder**:
Candidate sources are sought in this order: known-ATS search results, career-page ATS links, ATS showcases or directories, community submissions, then independently reverified public datasets. Discovery may propose a source but cannot index it without verification.
_Avoid_: Unverified bulk import

**Discovery credential**:
An optional maintainer-provided search key that accelerates candidate discovery. Discovery remains functional without it, and neither verification nor the shipped plugin may depend on it.
_Avoid_: Runtime API key, required credential

**Verification**:
An automated check that a discovered structured source is reachable and belongs to the identified company. Successful verification permits automatic index inclusion; each job is classified separately.
_Avoid_: Manual approval, unverified submission
