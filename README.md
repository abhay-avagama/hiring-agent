# Openings

Openings is a free, read-only job-search substrate for AI agents. It indexes public company job boards and exposes two tools: `search_jobs` and `get_job`. There are no accounts, hosted services, API keys, model calls, resume uploads, or application submission paths.

The initial release supports Greenhouse, Lever, and Ashby. Jobs are crawled from their public structured endpoints into a local, source-partitioned snapshot. The bundled source catalog is deliberately small while its verification pipeline grows.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer

## Use the CLI

```sh
bun install
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

## Add a company

Add one entry keyed by a stable lowercase slug:

```json
"example": { "name": "Example", "ats": "greenhouse", "token": "example", "cohorts": ["IN"] }
```

The token is the public board identifier visible in the company's job-board URL. Supported `ats` values are `greenhouse`, `lever`, and `ashby`. `cohorts` records how a source was selected for focused crawling; eligibility is always classified on each job. India searches normalize common city and state variants such as Bangalore/Bengaluru, Gurgaon/Gurugram, Mysore/Mysuru, and Orissa/Odisha.

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
