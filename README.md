# Openings

[![smithery badge](https://smithery.ai/badge/avagama/openings)](https://smithery.ai/servers/avagama/openings)

A free, candidate-safe job search for AI agents.

Openings indexes public company job boards into a private index on your machine and exposes it to any MCP client. Your agent can find roles that fit a resume, explain the fit with evidence, and propose truthful resume improvements. Installed this way there are no accounts and no API keys; there are never model calls and never a way to submit an application.

Two ways to run it, with different data rules:

| | On your machine (this package) | Hosted connector at `openings.avagama.co/mcp` |
|---|---|---|
| Sign-in | None | Email code, so an account exists |
| Job index | Built and stored on your machine | Ours, shared |
| Resume | Parsed in memory for one request, never written to disk | Sent to our server, processed in memory for that request, then discarded |
| What we receive | Crawl reports, plus anonymous usage events unless you turn them off | The same usage record, keyed to your account |

Both are covered in [Sharing crawls and usage](#sharing-crawls-and-usage) and on the [privacy page](https://avagama.co/privacy/).

- **Eleven providers plus company sites.** Greenhouse, Lever, Ashby, Workday, Recruitee, SmartRecruiters, Workable, Breezy, Freshteam, Keka, and Zoho Recruit, crawled from their public structured endpoints, plus employer career sites read only through the schema.org JobPosting markup they publish for search engines. No free-form HTML scraping.
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

On first use the agent downloads the shared index of every verified source in one call, reports real coverage, and only then asks for a resume; only missing or stale sources are crawled, in batches of 25. Results come back in three buckets: direct title matches, hidden roles found through grounded title families, and stretch roles, each with separate evidence and keyword scores. The index lives under `~/.openings`.

The [job-seeker quickstart](docs/job-seeker-quickstart.md) has sample prompts, an example conversation, privacy details, and common errors.

## The tools

| Tool | What it does |
| --- | --- |
| `prepare_job_search` | Builds or refreshes the index for your countries and reports coverage. Uses the network, never touches a resume. |
| `get_job_coverage` | Reports current coverage with no network access. |
| `recommend_jobs` | Ranks jobs against a resume and explicit intent. Returns direct, hidden, and stretch results with evidence. Performs at most one scoped refresh; `refresh.policy: "never"` guarantees no crawl. |
| `analyze_job_fit` | Explains one job against verbatim resume evidence: supported, transferable, unsupported, and screening risks. |
| `optimize_resume` | Proposes grounded suggestions, an additive diff, or revised Markdown. Never invents experience. |
| `search_jobs` | Resume-free keyword, location, country, remote, and stated-experience search, newest first. `country` takes a two-letter code such as `IN`. Optional `experienceYears` compares stated min/max ranges, excluding unknowns unless `includeUnknownExperience: true`. Results include `pagination.total` and `pagination.nextOffset`; request the next page with that `offset`, unchanged filters, and `maxAgeDays` set to the returned `window.daysUsed`. Restart pagination after index refresh; this is not a frozen snapshot cursor. Without `maxAgeDays`, search widens through 7/14/30/all days until at least five results exist. |
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

## Sharing crawls and usage

The packaged server reports each source you crawl to the shared Openings aggregator at `openings.avagama.co`, which merges reports from every install and publishes the result. New installs download the published index for their countries on first setup instead of crawling every source. Only public job data is sent in crawl reports, never resume content.

The server also sends anonymous usage events so we can see what people search for and improve coverage. Each install gets a random ID on first run, stored in the data directory. An event records the tool that ran, the countries, the intent fields you passed (roles, seniority, skills, remote, query text), the IDs of jobs you opened, and the skill and title values the parser extracted from a resume. It never includes the resume text, the quoted evidence, your name, or contact details, and no IP address is stored with it. Set `OPENINGS_USAGE=off` to stop usage events while keeping the shared index, or set `OPENINGS_AGGREGATOR_URL` to an empty string to keep everything local. The source entrypoint reports only when the aggregator variable is set.

On startup the server makes one request to the npm registry to learn the latest version. If yours is older, every tool result carries an `updateAvailable` note so your AI app can tell you to run `bun add --global openings`. Nothing on your machine is changed automatically. Set `OPENINGS_UPDATE_CHECK=off` to skip the check.

## Privacy

Job data comes straight from public ATS endpoints and is stored only on your machine. Your MCP client reads the resume file and passes its content to a tool; Openings never sees the path, and it never writes the resume to disk, logs it, or sends it anywhere.

One thing derived from a resume does leave your machine while usage reporting is on, which is the default: the skill and title words the parser extracted, in the anonymous event described in [Sharing crawls and usage](#sharing-crawls-and-usage). Never the resume text, the quoted evidence, your name, or your contact details. `OPENINGS_USAGE=off` stops it, and an empty `OPENINGS_AGGREGATOR_URL` keeps everything local.

Every proposed change stays subject to your review.

## Develop

```sh
bun test
bun run typecheck
bun run test:live   # one real board per provider, needs internet
```

## License

[MIT](LICENSE)
