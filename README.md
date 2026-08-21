# Openings

Openings is a free, read-only job-search substrate for AI agents. It indexes public company job boards and exposes six tools: `get_job_coverage`, `recommend_jobs`, `analyze_job_fit`, `optimize_resume`, `search_jobs`, and `get_job`. There are no accounts, hosted services, Openings API keys, model calls, or application submission paths. Resume content supplied to the recommendation, fit-analysis, and optimization tools is processed locally in memory and is never persisted.

Openings supports Greenhouse, Lever, Ashby, Workday, and Recruitee. Jobs are crawled from their public structured endpoints into a local, source-partitioned snapshot.

## Start as a job seeker

After the one-time local snapshot bootstrap, you do not need to learn the crawler or run search commands. Connect this repository as an MCP server, then ask your AI agent:

> Show me what Openings currently covers in India. If the coverage is useful, use my resume to find backend roles, including good jobs whose titles I would not have searched for. Rank by evidence and explain every gap.

Openings first reports its real job and employer coverage, then accepts a text or Markdown resume. It returns direct, hidden, and stretch opportunities with separate evidence and keyword scores. See the [job-seeker quickstart](docs/job-seeker-quickstart.md) for setup, sample prompts, an example conversation, privacy details, and common errors.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer

## Use the CLI

```sh
bun install
bun run src/cli.ts sources discover-yc --country IN
bun run src/cli.ts sources discover-common-crawl --country IN
bun run src/cli.ts sources seed-companies-yc --country IN
bun run src/cli.ts sources enrich .openings/company-domains.json --companies another-authoritative-dataset.json --evidence-kind authoritative_dataset
bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN --common-crawl-report .openings/common-crawl-discovery-report.json
bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN
# Optional: search known ATS hosts before trying keyless career redirects and datasets
BRAVE_SEARCH_API_KEY=... bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN --search-key-env BRAVE_SEARCH_API_KEY
bun run src/cli.ts sources discover discovery-feed.json --country IN
bun run src/cli.ts sources verify data/source-candidates.json --registry data/enrichment-leads.json --require-country IN --limit 50
bun run src/cli.ts crawl
bun run src/cli.ts crawl --country IN
bun run src/cli.ts crawl --companies companies.txt
bun run src/cli.ts snapshot export
bun run src/cli.ts coverage report --country IN
bun run src/cli.ts search "platform engineer" --remote --limit 10
bun run src/cli.ts search "backend engineer" --india --limit 20
bun run src/cli.ts search "backend engineer" --country DE --stale-days 7
bun run src/cli.ts search developer --offline
bun run src/cli.ts search developer --india --location Bangalore
bun run src/cli.ts get greenhouse:anthropic:12345
```

Commands return JSON so the same interface works for people, shell scripts, and agents. Search refreshes a missing or stale snapshot automatically; the default freshness window is 14 days. Use `--stale-days N` to change it or `--offline` to guarantee that no network request is made. Openings does not install a scheduler—run `crawl` using whichever scheduler you prefer.

`get_job_coverage` reports current job-level coverage for requested countries before a candidate supplies a resume. `recommend_jobs` includes the same projection for its requested countries. Both report indexed sources containing eligible jobs, eligible-job count, and distinct eligible employer domains; discovery cohorts are provenance and are never presented as coverage.

`recommend_jobs` explores beyond exact titles without discovering new sources during a user request. It derives bounded title families from explicit intent or validated resume facts, runs the existing evidence matcher across the local snapshot, and returns direct, hidden title-family, and stretch buckets. Every hidden result identifies all grounded aliases that surfaced it and whether each expansion came from user intent or resume fact IDs; generic titles require corroborating family signals in the job description. Refresh policy remains unchanged: at most one crawl of relevant verified sources followed by one rematch.

Catalog and candidate writers wait up to 60 seconds to acquire their file lock; this never limits the operation after it acquires the lock. Set `OPENINGS_LOCK_TIMEOUT_MS` to change only that wait ceiling. Timeout errors identify the current holder's PID, operation, and start time.
Use `lock inspect TARGET` to inspect a blocked writer. `lock force-release TARGET --force` is an explicit operator recovery action; use it only after confirming the recorded holder is no longer performing work.

`crawl` considers every source by default and skips partitions fetched within the last 24 hours. `--country CODE` selects the maintained discovery cohort for that country; it does not label companies as country-specific. `--companies FILE` accepts one catalog slug per line. Missing sources are selected first, then the oldest expired partitions. Successful selected sources replace their partitions; failed refreshes preserve existing stale jobs and are reported; unselected partitions remain intact. Use `--source-cache-hours 0` to force refresh eligibility and `--source-limit N` to bound a rotation. Reports include each source's attempts, duration, total jobs, country-job counts, and final error. Transient source failures receive one lower-pressure retry; Workday pagination also backs off on throttling and transient gateway responses.

`snapshot export` reads `.openings/snapshot.json` by default and writes a distributable manifest plus deterministic per-source partitions under `.openings/dist`. Every partition carries a SHA-256 checksum in the manifest, along with compact source, job, and country-count summaries. Use `--input FILE` and `--output-dir PATH` to select other locations.

`coverage report --country CODE` is an offline maintainer report over the verified catalog, source candidates, enrichment registry, and local snapshot. It reports global catalog/index totals alongside explicitly labeled country-cohort source counts; country cohorts describe discovery provenance, while eligible-job counts are computed independently from job-level eligibility. Distinct eligible employers are unique verified company domains with at least one eligible job. It also reports the latest rotation batch's success rate, provider distributions, confidence distributions for all indexed and eligible jobs, global registry yield, global and country-cohort candidate-promotion yields, orphaned and never-indexed sources, and actionable partition-freshness buckets. The default output is `.openings/country-coverage-CODE.json`. Use a canonical timestamp such as `--as-of 2026-08-19T00:00:00.000Z` for byte-stable repeated reports and `--snapshot`, `--catalog`, `--candidates`, `--registry`, or `--output` to select other inputs.

## Verify and promote sources

Discovery is keyless and separate from verification. Four inputs are available:

```sh
# Probe country-filtered company seeds from the public YC company API
bun run src/cli.ts sources discover-yc --country IN

# Ingest a static, community, search-result, or public-dataset feed
bun run src/cli.ts sources discover discovery-feed.json --country IN

# Discover canonical ATS URL leads from the latest Common Crawl URL index
bun run src/cli.ts sources discover-common-crawl --country IN

# Generate the company identity seeds required by career tracing
bun run src/cli.ts sources seed-companies-yc --country IN

# Follow company-owned career redirects, then verify and promote resolved sources
bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN --common-crawl-report .openings/common-crawl-discovery-report.json
```

`seed-companies-yc` writes a deduplicated country-focused `{ companyName, companyDomain }` seed file to `.openings/company-domains.json` by default. This is the required identity input for `trace-careers`; the file is generated rather than assumed to exist.

`discover-common-crawl` queries only Common Crawl's URL index for Greenhouse, Lever, Ashby, Workday, and Recruitee URL patterns, capped at 10,000 records per pattern to keep the public-index workload bounded. It does not download archived pages. Unknown sources are merged by canonical provider token into `data/enrichment-leads.json`; reports are versioned run artifacts rather than workflow state. `--country` records the campaign target but cannot assign a country to an unidentified source; job eligibility remains job-derived after verification and crawling.

`sources enrich COMPANIES.json` joins the durable lead registry against authoritative company-domain data and derives state from accumulated facts. Add repeatable `--companies FILE` inputs to combine datasets. Inputs may be `{ companyName, companyDomain }` arrays or verified catalog objects such as `data/companies.json`; every fact retains its input-file provenance. Weak token/name/search matches never become identity evidence. Greenhouse and Workday may become verification-ready through authoritative dataset evidence; Lever and Ashby remain matched until provider-structured or safely replayed company-redirect evidence exists. Recruitee is the narrow exception at the acquisition boundary: a matched lead may be probed because its live structured jobs can supply an exact company-owned domain link, but it is promoted only when that strong evidence is actually present. Equal-trust identity conflicts are quarantined, while higher-trust evidence wins deterministically. The registry records verification outcomes, capped retry cooldowns, file size, and lock-held time; use `sources verify ... --registry FILE` to write those outcomes back.
Cooling, repeatedly failing, unresolved, matched, and rejected registry leads are not re-probed automatically, except that a never-attempted matched Recruitee lead may undergo the provider-time identity-acquisition probe described above. Use `--retry-deferred` on an explicit verification run to retry only cooling or repeatedly failing leads that already meet the identity-evidence bar; it never bypasses unresolved or quarantined identity states, nor does it make a failed matched Recruitee lead eligible again.

Verification limits Workday to two concurrent boards by default, shares provider cooldowns after HTTP 429 responses, and honors bounded `Retry-After` delays. Override the Workday ceiling with `--workday-concurrency N` only when the endpoint tolerates it. `--limit N` selects never-attempted candidates first, then rotates every attempted candidate to the back regardless of success or failure; untouched catalog refreshes begin with the oldest verification timestamp. The durable rotation ledger defaults beside the catalog as `CATALOG.verification-state.json` and can be changed with `--state-file FILE`. Every source outside the batch remains preserved. Reports separate total/new/selected/deferred candidates, retryable failures, transiently preserved sources, and untouched catalog entries carried forward.

`trace-careers` accepts a JSON array of company identity seeds. `careerUrl` is optional; without it Openings checks the conventional HTTPS `/careers`, `/career`, and `/jobs` paths. With `--search-key-env NAME`, it first uses Brave Search to look for matching results on known ATS hosts; the key is read from the named environment variable rather than exposed as a command argument. It then sends `HEAD` requests to company-owned career paths, follows redirects, and never reads career-page HTML. Every hop is DNS-checked and connected to the validated public address. Finally, `--common-crawl-report FILE` joins durable ATS leads whose token exactly matches the normalized company name or domain. Greenhouse must expose a matching provider name, Workday a matching tenant, and Lever/Ashby either a structured domain link or a company-owned redirect that verification safely replays to the exact board.

Workday CXS is the first enterprise-scale provider. Its adapter walks the complete public JSON result set and normalizes summaries without scraping rendered career pages; a job detail is fetched from the structured endpoint only when requested. The verified catalog currently contains 105 sources, 63 of them Workday. A bulk source is retained only after its complete feed contributes India-eligible jobs; a first-page identity check alone is insufficient. The Workday verifier checks the public CXS feed and its URL-derived tenant identifier, but the payload does not independently prove ownership of a claimed company domain. iCIMS is not enabled because its official API requires credentials, and tenant-specific SuccessFactors RSS feeds are accepted only after they demonstrate complete, correctly filtered results.

Workday source resolution accepts an exact locale/site board URL, an exact public job-detail URL under that board, or an exact `/wday/cxs/{tenant}/{site}/jobs` endpoint. Public URLs are deterministically converted to that exact CXS endpoint before structured probing. Arbitrary tenant paths such as `robots.txt` remain inert if present in a legacy registry and can never become source candidates.

```json
[
  {
    "companyName": "Example",
    "companyDomain": "example.com",
    "careerUrl": "https://example.com/careers"
  }
]
```

The YC campaign uses published company names, domains, locations, and slugs to propose possible Greenhouse boards. Generic discovery accepts all five supported ATS providers and performs no live identity probe: it requires `companyName` and `companyDomain`, and only a company-owned redirect may be supplied as replayable evidence by a generic feed. Live provider identity is checked exactly once by verification; Recruitee can acquire its qualifying structured-domain evidence during that check. Candidate, registry, and catalog updates are serialized so concurrent user-scheduled campaigns cannot overwrite one another. A country option adds discovery-cohort provenance; it never claims that the company or every job belongs to that country.

The first live India YC campaign examined 218 seeds, discovered and independently verified Groww, Able, and Raven, and expanded the India crawl cohort from 9 to 12 sources. Seed-token probing has deliberately low yield but no search key, guessed domain, HTML scraping, or silent import.

[`data/source-candidates.json`](data/source-candidates.json) is the candidate source of truth. Each candidate records the company name and domain, a supported public ATS URL, optional discovery cohorts, and how it was discovered. Run:

```sh
bun run src/cli.ts sources verify data/source-candidates.json
```

The verifier resolves canonical Greenhouse, Lever, Ashby, Workday, and Recruitee endpoints, validates their structured payloads, applies provider-specific identity checks, deduplicates sources and companies, and atomically regenerates [`data/companies.json`](data/companies.json). Greenhouse supplies a provider company name. Workday supplies a URL-derived tenant identifier but no independent company-domain ownership proof. Recruitee jobs may supply a company-owned careers URL, which must match the candidate company domain before promotion. Lever and Ashby may use either a dedicated structured company-domain field or company-owned redirect evidence produced by the hardened career tracer; board slugs or free-form job descriptions never count alone. Only accepted candidates are written. The JSON report includes every rejected candidate and a machine-readable reason. Previously verified records survive transient endpoint failures, but permanent identity or schema failures remove them. Verification requires no search key; optional keys belong only to discovery adapters.

For a country expansion campaign, add `--require-country IN`. It admits a new source only when its complete normalized feed contains an India-eligible job; existing verified sources are preserved if their current feed temporarily has none.

The current public Lever and Ashby payloads do not provide an authoritative company-domain identity field for the seed candidates, so Flex and PostHog remain quarantined until their company-owned career pages produce a verifiable redirect to those exact boards. Openings does not parse career-page HTML or accept self-asserted redirect evidence.

Candidate example:

```json
{
  "companyName": "Example",
  "companyDomain": "example.com",
  "sourceUrl": "https://job-boards.greenhouse.io/example",
  "cohorts": ["IN"],
  "discoveredFrom": { "channel": "community", "reference": "issue-123" }
}
```

## Use the MCP server

Run the stdio server directly:

```sh
bun run src/mcp.ts
```

For a client that accepts MCP configuration, point a stdio server at `bun` with arguments `run` and the absolute path to `src/mcp.ts`. The included [`.mcp.json`](.mcp.json) is discovered when this repository is installed as a Codex plugin.

The server exposes only:

- `get_job_coverage(countries)` — reports current job-level source, job, and distinct-employer coverage without requiring or processing a resume
- `recommend_jobs(resume, intent, ranking?, refresh?, limit?)` — parses text or Markdown resume content, applies job-level eligibility constraints, returns the same coverage projection for requested countries, and returns both evidence and keyword percentages with evidence-grounded explanations. `ranking.mode` lets the applicant select `evidence` (default) or `keyword`; `ranking.minimumPercent` filters the selected score. It performs at most one scoped refresh, and `refresh.policy: "never"` guarantees no crawl
- `analyze_job_fit(jobId, resume, intent?)` — analyzes one selected job against verbatim resume evidence, returning both percentages while separating explicit support, transferable evidence, unsupported requirements, screening risks, and interview preparation gaps
- `optimize_resume(jobId, resume, output)` — returns grounded suggestions, an additive unified diff, or revised Markdown without overwriting the supplied resume; unsupported requirements remain gaps, and unified diffs identify their deterministic normalized base in `diffBase`
- `search_jobs(query?, location?, country?, remote?, limit?)` — `country` accepts a two-letter country code such as `IN` or `DE`
- `get_job(id)`

It intentionally exposes no write, form-fill, or submit tool.

## Add a candidate

Add an object to `data/source-candidates.json`; do not edit the generated company catalog directly. An optional stable `slug` preserves existing job IDs when it differs from the first part of the company domain.

```json
{ "companyName": "Example", "companyDomain": "example.com", "sourceUrl": "https://job-boards.greenhouse.io/example", "cohorts": ["IN"], "discoveredFrom": { "channel": "community", "reference": "issue-123" } }
```

Supported sources are Greenhouse, Lever, Ashby, Workday, and Recruitee public job-board URLs. `cohorts` records how a source was selected for focused crawling; eligibility is always classified on each job. India searches normalize common city and state variants such as Bangalore/Bengaluru, Gurgaon/Gurugram, Mysore/Mysuru, and Orissa/Odisha.

## Develop

```sh
bun test
bun run typecheck
bun run test:live # verifies one real board per ATS; requires internet access
```

## Privacy and application safety

Job data comes directly from public ATS endpoints and is stored under `.openings/` by default. Openings does not scrape arbitrary career-page HTML. The MCP host reads any source resume file and sends only its content to `recommend_jobs`, `analyze_job_fit`, or `optimize_resume`; Openings never receives or reads the filesystem path and never persists the resume content or derived profile. Every proposed revision remains subject to human review, and Openings never submits an application.

### Expand the corpus

Run the complete country campaign against a local Markdown list of company career-page links:

```sh
bun run expand:corpus -- \
  --country IN \
  --input data/companies-career-page.md \
  --crawl-delay-ms 500 \
  --common-crawl-report .openings/common-crawl-discovery-report.json
```

The campaign extracts company-owned HTTPS career URLs from HTML or ordinary Markdown links, traces them with HEAD requests in isolated batches, verifies every evidence-ready ATS source once, crawls the verified country cohort once, and prints machine-readable phase heartbeats plus before/after company and job counts. `--crawl-delay-ms` (default: `500`) spaces source starts globally to reduce request bursts and 429 responses while retaining bounded concurrency. Weak matches are never promoted without qualifying identity evidence. Use `--batch-size`, `--trace-concurrency`, `--verify-concurrency`, `--workday-concurrency`, or `--crawl-concurrency` to tune a campaign.

If a run is interrupted after tracing or verification, resume only the remaining phases rather than repeating completed work:

```sh
bun run expand:corpus -- --country IN --skip-trace --skip-verify --crawl-delay-ms 1000
```

`--skip-trace`, `--skip-verify`, and `--skip-crawl` are explicit operator controls; skipped phases are reported in the JSON output.

## License

MIT
