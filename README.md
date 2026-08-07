# Openings

Openings is a free, read-only job-search substrate for AI agents. It indexes public company job boards and exposes two tools: `search_jobs` and `get_job`. There are no accounts, hosted services, API keys, model calls, resume uploads, or application submission paths.

The initial release supports Greenhouse, Lever, and Ashby. The bundled index is deliberately small; add companies to [`data/companies.json`](data/companies.json) as the community-maintained asset grows.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer

## Use the CLI

```sh
bun install
bun run src/cli.ts search "platform engineer" --remote --limit 10
bun run src/cli.ts search "backend engineer" --india --limit 20
bun run src/cli.ts search developer --india --location Bangalore
bun run src/cli.ts get greenhouse:anthropic:12345
```

Commands return JSON so the same interface works for people, shell scripts, and agents.

## Use the MCP server

Run the stdio server directly:

```sh
bun run src/mcp.ts
```

For a client that accepts MCP configuration, point a stdio server at `bun` with arguments `run` and the absolute path to `src/mcp.ts`. The included [`.mcp.json`](.mcp.json) is discovered when this repository is installed as a Codex plugin.

The server exposes only:

- `search_jobs(query?, location?, country?, remote?, limit?)` — use `country: "IN"` for roles explicitly located in India or remote across India/APAC/Asia/global
- `get_job(id)`

It intentionally exposes no write, form-fill, or submit tool.

## Add a company

Add one entry keyed by a stable lowercase slug:

```json
"example": { "name": "Example", "ats": "greenhouse", "token": "example", "markets": ["IN"] }
```

The token is the public board identifier visible in the company's job-board URL. Supported `ats` values are `greenhouse`, `lever`, and `ashby`. Add `markets: ["IN"]` only after verifying that a board currently carries India-eligible roles; live index-freshness tests check every marked board. India searches normalize common city and state variants such as Bangalore/Bengaluru, Gurgaon/Gurugram, Mysore/Mysuru, and Orissa/Odisha.

## Develop

```sh
bun test
bun run typecheck
bun run test:live # verifies one real board per ATS; requires internet access
```

## Privacy and application safety

Job data comes directly from public ATS endpoints and is cached in memory for five minutes. `resume.md` and `voice.md` are read only by the user's own agent through the included skill; this package never receives them. The skill forbids fabricated claims and requires a human to review and submit every application.

## License

MIT
