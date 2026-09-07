# Openings

A free, candidate-safe job search for AI agents.

Openings indexes public company job boards into a private index on your machine and exposes it to any MCP client. Your agent can find roles that fit a resume, explain the fit with evidence, and propose truthful resume improvements. There are no accounts, no API keys, no model calls, and no way to submit an application.

- **Eight providers.** Greenhouse, Lever, Ashby, Workday, Recruitee, SmartRecruiters, Workable, and Breezy, crawled from their public structured endpoints. No HTML scraping.
- **Verified sources only.** Every company in the catalog passed an identity check against its own board.
- **Resumes stay in memory.** Resume content is parsed for a single request and never written to disk.
- **Honest coverage.** Before you share a resume, Openings tells you how many employers and jobs it actually has for your countries.

## For job seekers

Install [Bun](https://bun.sh/) 1.3 or newer, then the package with whichever package manager you use:

```sh
bun add --global openings
# or
npm install --global openings
# or
yarn global add openings
```

Bun must be on your `PATH` either way; it is the runtime the server runs on.

Add the server to your MCP client:

```json
{
  "mcpServers": {
    "openings": { "command": "openings-mcp", "args": [] }
  }
}
```

Then ask your agent something like:

> Show me what Openings covers in India. If that looks useful, use my resume to find backend roles, including good jobs whose titles I would not have searched for. Rank by evidence and explain every gap.

On first use the agent builds your private index in resumable batches of ten sources, reports real coverage, and only then asks for a resume. Results come back in three buckets: direct title matches, hidden roles found through grounded title families, and stretch roles, each with separate evidence and keyword scores. The index lives under `~/.openings`.

The [job-seeker quickstart](docs/job-seeker-quickstart.md) has sample prompts, an example conversation, privacy details, and common errors.

## The tools

| Tool | What it does |
| --- | --- |
| `prepare_job_search` | Builds or refreshes the index for your countries and reports coverage. Uses the network, never touches a resume. |
| `get_job_coverage` | Reports current coverage with no network access. |
| `recommend_jobs` | Ranks jobs against a resume and explicit intent. Returns direct, hidden, and stretch results with evidence. Performs at most one scoped refresh; `refresh.policy: "never"` guarantees no crawl. |
| `analyze_job_fit` | Explains one job against verbatim resume evidence: supported, transferable, unsupported, and screening risks. |
| `optimize_resume` | Proposes grounded suggestions, an additive diff, or revised Markdown. Never invents experience. |
| `search_jobs` | Plain keyword, location, country, and remote search over the index. `country` takes a two-letter code such as `IN`. |
| `get_job` | Returns one job with its full description. |

There is deliberately no form-fill, apply, or submit tool. The only thing Openings writes is your own job index.

## From a source checkout

```sh
bun install
bun run src/mcp.ts                                    # stdio MCP server
bun run src/cli.ts crawl --country IN                 # build the index
bun run src/cli.ts search "platform engineer" --remote
bun run src/cli.ts get greenhouse:anthropic:12345
```

CLI commands return JSON. Search refreshes a missing or stale index automatically; pass `--offline` to guarantee no network request. The source entrypoint stores its index under `.openings` in the working directory unless `OPENINGS_DATA_DIR` is set. The included [`.mcp.json`](.mcp.json) is picked up when this repository is installed as a Codex plugin.

Discovery campaigns, source verification, corpus expansion, coverage reports, and lock recovery are documented in the [maintainer guide](docs/maintainer-guide.md).

## Add a company

Append a candidate to [`data/source-candidates.json`](data/source-candidates.json) and run verification. Never edit the generated catalog in `data/companies.json` by hand.

```json
{
  "companyName": "Example",
  "companyDomain": "example.com",
  "sourceUrl": "https://job-boards.greenhouse.io/example",
  "cohorts": ["IN"],
  "discoveredFrom": { "channel": "community", "reference": "issue-123" }
}
```

```sh
bun run src/cli.ts sources verify data/source-candidates.json
```

The verifier resolves the canonical board endpoint, validates its payload, applies the provider's identity check, and regenerates the catalog atomically. Rejected candidates are reported with a machine-readable reason. Boards discovered without a known company website can enter as *board-verified* sources instead, admitted on the provider's own identity and marked `provider_board` in the catalog so tools and pages can label them; see the maintainer guide. `cohorts` records why a source was selected for a country campaign; eligibility is always decided per job. An optional `slug` keeps existing job IDs stable when it differs from the first label of the company domain.

## Sharing crawls

The packaged server reports each source you crawl to the shared Openings aggregator at `openings.avagama.co`, which merges reports from every install and publishes the result. New installs download the published index on first setup instead of crawling every source. Only public job data is sent, never resume content. Set `OPENINGS_AGGREGATOR_URL` to an empty string to keep every crawl local, or to another URL to use your own aggregator. The source entrypoint reports only when the variable is set.

## Privacy

Job data comes straight from public ATS endpoints and is stored only on your machine. Your MCP client reads the resume file and passes its content to a tool; Openings never sees the path and never persists the content or anything derived from it. Every proposed change stays subject to your review.

## Develop

```sh
bun test
bun run typecheck
bun run test:live   # one real board per provider, needs internet
```

## License

[MIT](LICENSE)
