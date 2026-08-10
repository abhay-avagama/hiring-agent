# Openings

Openings is a free, read-only job-search substrate for AI agents. It indexes public company job boards and exposes two tools: `search_jobs` and `get_job`. There are no accounts, hosted services, API keys, model calls, resume uploads, or application submission paths.

The initial release supports Greenhouse, Lever, and Ashby. Jobs are crawled from their public structured endpoints into a local, source-partitioned snapshot. The bundled source catalog is deliberately small while its verification pipeline grows.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer

## Use the CLI

```sh
bun install
bun run src/cli.ts sources discover-yc --country IN
bun run src/cli.ts sources discover-common-crawl --country IN
bun run src/cli.ts sources seed-companies-yc --country IN
bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN --common-crawl-report .openings/common-crawl-discovery-report.json
bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN
# Optional: search known ATS hosts before trying keyless career redirects and datasets
BRAVE_SEARCH_API_KEY=... bun run src/cli.ts sources trace-careers .openings/company-domains.json --country IN --search-key-env BRAVE_SEARCH_API_KEY
bun run src/cli.ts sources discover discovery-feed.json --country IN
bun run src/cli.ts sources verify data/source-candidates.json
bun run src/cli.ts crawl
bun run src/cli.ts crawl --country IN
bun run src/cli.ts crawl --companies companies.txt
bun run src/cli.ts search "platform engineer" --remote --limit 10
bun run src/cli.ts search "backend engineer" --india --limit 20
bun run src/cli.ts search "backend engineer" --country DE --stale-days 7
bun run src/cli.ts search developer --offline
bun run src/cli.ts search developer --india --location Bangalore
bun run src/cli.ts get greenhouse:anthropic:12345
```

Commands return JSON so the same interface works for people, shell scripts, and agents. Search refreshes a missing or stale snapshot automatically; the default freshness window is 14 days. Use `--stale-days N` to change it or `--offline` to guarantee that no network request is made. Openings does not install a scheduler—run `crawl` using whichever scheduler you prefer.

`crawl` updates every source by default. `--country CODE` selects the maintained discovery cohort for that country; it does not label companies as country-specific. `--companies FILE` accepts one catalog slug per line. Successful selected sources replace their partitions, failures are removed and reported, and unselected partitions remain intact.

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

`discover-common-crawl` queries only Common Crawl's URL index for Greenhouse, Lever, Ashby, and Workday URL patterns, capped at 10,000 records per pattern to keep the public-index workload bounded. It does not download archived pages. Known sources are counted separately; new URLs remain unresolved leads in `.openings/common-crawl-discovery-report.json` until a trustworthy company name and domain can be linked to them. `--country` records the campaign target but cannot assign a country to an unidentified source; job eligibility remains job-derived after verification and crawling.

`trace-careers` accepts a JSON array of company identity seeds. `careerUrl` is optional; without it Openings checks the conventional HTTPS `/careers`, `/career`, and `/jobs` paths. With `--search-key-env NAME`, it first uses Brave Search to look for matching results on known ATS hosts; the key is read from the named environment variable rather than exposed as a command argument. It then sends `HEAD` requests to company-owned career paths, follows redirects, and never reads career-page HTML. Finally, `--common-crawl-report FILE` joins durable ATS leads whose token exactly matches the normalized company name or domain. The default remains keyless and simply skips the search step. Resolved candidates enter the normal verifier automatically: Greenhouse must expose a matching provider name, Workday must expose a matching public tenant and valid CXS jobs payload, while Lever and Ashby still require a structured company-domain link. Redirects, URL-index leads, and search results resolve sources but do not weaken identity verification.

Workday CXS is the first enterprise-scale provider. Its adapter walks the complete public JSON result set and normalizes summaries without scraping rendered career pages; a job detail is fetched from the structured endpoint only when requested. Mastercard is the first verified seed. iCIMS is not enabled because its official API requires credentials, and tenant-specific SuccessFactors RSS feeds are accepted only after they demonstrate complete, correctly filtered results.

```json
[
  {
    "companyName": "Example",
    "companyDomain": "example.com",
    "careerUrl": "https://example.com/careers"
  }
]
```

The YC campaign uses published company names, domains, locations, and slugs to probe possible Greenhouse boards. The generic feed accepts objects containing `sourceUrl`, optional `companyDomain`, `channel`, and `reference`, but feed authors cannot self-assert authoritative domain evidence: generic matches remain unresolved until a trusted enrichment adapter validates the domain. Discovery canonicalizes and probes sources, safely merges trusted matches into `data/source-candidates.json`, writes every unresolved/rejected record to `.openings/*-discovery-report.json`, then automatically runs verification and regenerates `data/companies.json`. Candidate and catalog updates are serialized so concurrent user-scheduled campaigns cannot overwrite one another. A country option adds discovery-cohort provenance; it never claims that the company or every job belongs to that country.

The first live India YC campaign examined 218 seeds, discovered and independently verified Groww, Able, and Raven, and expanded the India crawl cohort from 9 to 12 sources. Seed-token probing has deliberately low yield but no search key, guessed domain, HTML scraping, or silent import.

[`data/source-candidates.json`](data/source-candidates.json) is the candidate source of truth. Each candidate records the company name and domain, a supported public ATS URL, optional discovery cohorts, and how it was discovered. Run:

```sh
bun run src/cli.ts sources verify data/source-candidates.json
```

The verifier resolves the canonical Greenhouse, Lever, or Ashby endpoint, validates its structured payload, checks source/name/domain identity, deduplicates sources and companies, and atomically regenerates [`data/companies.json`](data/companies.json). Greenhouse supplies a provider company name; Lever and Ashby must expose a company-domain link in a dedicated structured identity field—URLs in free-form descriptions never count. Only verified candidates are written. The JSON report includes every rejected candidate and a machine-readable reason. Previously verified records survive transient endpoint failures, but permanent identity or schema failures remove them. Verification requires no search key; optional keys will belong only to future discovery adapters.

The current public Lever and Ashby payloads do not provide an authoritative company-domain identity field for the seed candidates, so Flex and PostHog are intentionally quarantined. Their job adapters remain supported, but automatic identity verification for those providers is still open. We will not parse career-page HTML or weaken identity checks merely to increase the verified count.

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

- `search_jobs(query?, location?, country?, remote?, limit?)` — `country` accepts a two-letter country code such as `IN` or `DE`
- `get_job(id)`

It intentionally exposes no write, form-fill, or submit tool.

## Add a candidate

Add an object to `data/source-candidates.json`; do not edit the generated company catalog directly. An optional stable `slug` preserves existing job IDs when it differs from the first part of the company domain.

```json
{ "companyName": "Example", "companyDomain": "example.com", "sourceUrl": "https://job-boards.greenhouse.io/example", "cohorts": ["IN"], "discoveredFrom": { "channel": "community", "reference": "issue-123" } }
```

Supported sources are Greenhouse, Lever, and Ashby public job-board URLs. `cohorts` records how a source was selected for focused crawling; eligibility is always classified on each job. India searches normalize common city and state variants such as Bangalore/Bengaluru, Gurgaon/Gurugram, Mysore/Mysuru, and Orissa/Odisha.

## Develop

```sh
bun test
bun run typecheck
bun run test:live # verifies one real board per ATS; requires internet access
```

## Privacy and application safety

Job data comes directly from public ATS endpoints and is stored under `.openings/` by default. Openings does not scrape arbitrary career-page HTML. `resume.md` and `voice.md` are read only by the user's own agent through the included skill; this package never receives them. The skill forbids fabricated claims and requires a human to review and submit every application.

## License

MIT
