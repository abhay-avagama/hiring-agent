# Openings

Openings is a free, read-only job-search substrate for AI agents. It indexes public company job boards and exposes three tools: `recommend_jobs`, `search_jobs`, and `get_job`. There are no accounts, hosted services, Openings API keys, model calls, or application submission paths. Resume content supplied to `recommend_jobs` is processed locally in memory and is never persisted.

Openings supports Greenhouse, Lever, Ashby, and Workday. Jobs are crawled from their public structured endpoints into a local, source-partitioned snapshot.

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
bun run src/cli.ts search "platform engineer" --remote --limit 10
bun run src/cli.ts search "backend engineer" --india --limit 20
bun run src/cli.ts search "backend engineer" --country DE --stale-days 7
bun run src/cli.ts search developer --offline
bun run src/cli.ts search developer --india --location Bangalore
bun run src/cli.ts get greenhouse:anthropic:12345
```

Commands return JSON so the same interface works for people, shell scripts, and agents. Search refreshes a missing or stale snapshot automatically; the default freshness window is 14 days. Use `--stale-days N` to change it or `--offline` to guarantee that no network request is made. Openings does not install a scheduler—run `crawl` using whichever scheduler you prefer.

Catalog and candidate writers wait up to 60 seconds to acquire their file lock; this never limits the operation after it acquires the lock. Set `OPENINGS_LOCK_TIMEOUT_MS` to change only that wait ceiling. Timeout errors identify the current holder's PID, operation, and start time.
Use `lock inspect TARGET` to inspect a blocked writer. `lock force-release TARGET --force` is an explicit operator recovery action; use it only after confirming the recorded holder is no longer performing work.

`crawl` updates every source by default. `--country CODE` selects the maintained discovery cohort for that country; it does not label companies as country-specific. `--companies FILE` accepts one catalog slug per line. Successful selected sources replace their partitions, failures are removed and reported, and unselected partitions remain intact. Reports include each source's attempts, duration, total jobs, country-job counts, and final error. Transient source failures receive one lower-pressure retry; Workday pagination also backs off on throttling and transient gateway responses.

`snapshot export` reads `.openings/snapshot.json` by default and writes a distributable manifest plus deterministic per-source partitions under `.openings/dist`. Every partition carries a SHA-256 checksum in the manifest, along with compact source, job, and country-count summaries. Use `--input FILE` and `--output-dir PATH` to select other locations.

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

`discover-common-crawl` queries only Common Crawl's URL index for Greenhouse, Lever, Ashby, and Workday URL patterns, capped at 10,000 records per pattern to keep the public-index workload bounded. It does not download archived pages. Unknown sources are merged by canonical provider token into `data/enrichment-leads.json`; reports are versioned run artifacts rather than workflow state. `--country` records the campaign target but cannot assign a country to an unidentified source; job eligibility remains job-derived after verification and crawling.

`sources enrich COMPANIES.json` joins the durable lead registry against authoritative company-domain data and derives state from accumulated facts. Add repeatable `--companies FILE` inputs to combine datasets. Inputs may be `{ companyName, companyDomain }` arrays or verified catalog objects such as `data/companies.json`; every fact retains its input-file provenance. Weak token/name/search matches never become identity evidence. Greenhouse and Workday may become verification-ready through authoritative dataset evidence; Lever and Ashby remain matched until provider-structured or safely replayed company-redirect evidence exists. Equal-trust identity conflicts are quarantined, while higher-trust evidence wins deterministically. The registry records verification outcomes, capped retry cooldowns, file size, and lock-held time; use `sources verify ... --registry FILE` to write those outcomes back.
Cooling, repeatedly failing, unresolved, matched, and rejected registry leads are not re-probed automatically. Use `--retry-deferred` on an explicit verification run to retry only cooling or repeatedly failing leads that already meet the identity-evidence bar; it never bypasses matched, unresolved, or quarantined identity states.

Verification limits Workday to two concurrent boards by default, shares provider cooldowns after HTTP 429 responses, and honors bounded `Retry-After` delays. Override the Workday ceiling with `--workday-concurrency N` only when the endpoint tolerates it. `--limit N` selects never-attempted candidates first, then rotates every attempted candidate to the back regardless of success or failure; untouched catalog refreshes begin with the oldest verification timestamp. The durable rotation ledger defaults beside the catalog as `CATALOG.verification-state.json` and can be changed with `--state-file FILE`. Every source outside the batch remains preserved. Reports separate total/new/selected/deferred candidates, retryable failures, transiently preserved sources, and untouched catalog entries carried forward.

`trace-careers` accepts a JSON array of company identity seeds. `careerUrl` is optional; without it Openings checks the conventional HTTPS `/careers`, `/career`, and `/jobs` paths. With `--search-key-env NAME`, it first uses Brave Search to look for matching results on known ATS hosts; the key is read from the named environment variable rather than exposed as a command argument. It then sends `HEAD` requests to company-owned career paths, follows redirects, and never reads career-page HTML. Every hop is DNS-checked and connected to the validated public address. Finally, `--common-crawl-report FILE` joins durable ATS leads whose token exactly matches the normalized company name or domain. Greenhouse must expose a matching provider name, Workday a matching tenant, and Lever/Ashby either a structured domain link or a company-owned redirect that verification safely replays to the exact board.

Workday CXS is the first enterprise-scale provider. Its adapter walks the complete public JSON result set and normalizes summaries without scraping rendered career pages; a job detail is fetched from the structured endpoint only when requested. The maintained India discovery cohort now includes 72 verified sources, including major engineering employers such as Mastercard, NVIDIA, Cisco, Salesforce, Intel, Visa, PayPal, Fiserv, Cadence, ABB, Philips, Medtronic, Thermo Fisher, Hitachi, JLL, State Street, Danaher, and Kyndryl. A bulk source is retained only after its complete feed contributes India-eligible jobs; a first-page identity check alone is insufficient. iCIMS is not enabled because its official API requires credentials, and tenant-specific SuccessFactors RSS feeds are accepted only after they demonstrate complete, correctly filtered results.

```json
[
  {
    "companyName": "Example",
    "companyDomain": "example.com",
    "careerUrl": "https://example.com/careers"
  }
]
```

The YC campaign uses published company names, domains, locations, and slugs to propose possible Greenhouse boards. Generic discovery accepts all four supported ATS providers and performs no live identity probe: it requires `companyName` and `companyDomain`, and only a company-owned redirect may be supplied as replayable evidence by a generic feed. Live provider identity is checked exactly once by verification. Candidate, registry, and catalog updates are serialized so concurrent user-scheduled campaigns cannot overwrite one another. A country option adds discovery-cohort provenance; it never claims that the company or every job belongs to that country.

The first live India YC campaign examined 218 seeds, discovered and independently verified Groww, Able, and Raven, and expanded the India crawl cohort from 9 to 12 sources. Seed-token probing has deliberately low yield but no search key, guessed domain, HTML scraping, or silent import.

[`data/source-candidates.json`](data/source-candidates.json) is the candidate source of truth. Each candidate records the company name and domain, a supported public ATS URL, optional discovery cohorts, and how it was discovered. Run:

```sh
bun run src/cli.ts sources verify data/source-candidates.json
```

The verifier resolves canonical Greenhouse, Lever, Ashby, and Workday endpoints, validates their structured payloads, checks source/name/domain identity, deduplicates sources and companies, and atomically regenerates [`data/companies.json`](data/companies.json). Greenhouse supplies a provider company name and Workday supplies a tenant identity. Lever and Ashby may use either a dedicated structured company-domain field or company-owned redirect evidence produced by the hardened career tracer; board slugs or free-form job descriptions never count alone. Only verified candidates are written. The JSON report includes every rejected candidate and a machine-readable reason. Previously verified records survive transient endpoint failures, but permanent identity or schema failures remove them. Verification requires no search key; optional keys belong only to discovery adapters.

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

- `recommend_jobs(resume, intent, refresh?, limit?)` — parses text or Markdown resume content, applies job-level eligibility constraints, returns explained evidence-grounded matches, and performs at most one scoped refresh; `refresh.policy: "never"` guarantees no crawl
- `search_jobs(query?, location?, country?, remote?, limit?)` — `country` accepts a two-letter country code such as `IN` or `DE`
- `get_job(id)`

It intentionally exposes no write, form-fill, or submit tool.

## Add a candidate

Add an object to `data/source-candidates.json`; do not edit the generated company catalog directly. An optional stable `slug` preserves existing job IDs when it differs from the first part of the company domain.

```json
{ "companyName": "Example", "companyDomain": "example.com", "sourceUrl": "https://job-boards.greenhouse.io/example", "cohorts": ["IN"], "discoveredFrom": { "channel": "community", "reference": "issue-123" } }
```

Supported sources are Greenhouse, Lever, Ashby, and Workday public job-board URLs. `cohorts` records how a source was selected for focused crawling; eligibility is always classified on each job. India searches normalize common city and state variants such as Bangalore/Bengaluru, Gurgaon/Gurugram, Mysore/Mysuru, and Orissa/Odisha.

## Develop

```sh
bun test
bun run typecheck
bun run test:live # verifies one real board per ATS; requires internet access
```

## Privacy and application safety

Job data comes directly from public ATS endpoints and is stored under `.openings/` by default. Openings does not scrape arbitrary career-page HTML. The MCP host reads any source resume file and sends only its content to `recommend_jobs`; Openings never receives or reads the filesystem path and never persists the resume content or derived profile. The remaining legacy tailoring flow requires a human to review and submit every application.

## License

MIT
