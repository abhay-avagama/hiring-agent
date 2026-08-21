# Distribution channels for Openings

Checked against primary platform documentation on 2026-08-21.

## Finding

Openings already has a local Codex plugin manifest and an MCP server, but it is not packaged for broad public registries. The immediate distribution path is **package first, submit second**, not merely filling in a directory form.

## Viable channels

### Codex plugin

The repository contains `.codex-plugin/plugin.json`, `.mcp.json`, and the `openings` skill. Its candidate-facing metadata is maintained with the job-seeker quickstart. Public marketplace placement remains a separate release action; this repository proves local plugin installation, not public discoverability.

### Official MCP Registry

The [official MCP Registry publishing guide](https://modelcontextprotocol.io/registry/quickstart) supports public MCP metadata, but the registry hosts metadata rather than the executable. A local TypeScript server normally needs a public npm package or another supported public artifact, an `mcpName` in `package.json`, and a matching `server.json` before `mcp-publisher publish` can be used. The registry remains preview infrastructure.

Openings is not npm-packaged for one-command installation and has no `server.json`. The bounded next step is a packaging contract covering the executable entry point, included snapshot/data size, update policy, provenance, versioning, and installation testing.

### Anthropic Connectors Directory

Anthropic documents both local desktop extensions and remote connectors in its [connector guidance](https://support.claude.com/en/collections/15399129-connectors). Openings is local and stateless today, so a local MCPB/desktop-extension package is the closest fit. A remote submission would require hosting a publicly reachable MCP service and would change the current local-only architecture and privacy boundary.

Do not create a remote service merely for directory eligibility. First evaluate local MCPB packaging against Anthropic's current directory policy and submission checklist.

### ChatGPT apps

OpenAI recommends the Apps SDK for packaging and publishing app experiences backed by MCP tools. Its [Apps in ChatGPT guidance](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) distinguishes a custom workspace MCP app from broader directory/plugin distribution. The current stdio-only server is not automatically a publishable ChatGPT app. Apps SDK packaging or a remote MCP endpoint would be a new product surface and needs its own privacy, hosting, and review contract.

## Decision

No external submission is made in this phase. The next distribution ticket should compare two local-first packages:

1. an npm package plus `server.json` for the official MCP Registry; and
2. an MCPB desktop extension for Anthropic's local directory path.

ChatGPT Apps SDK and any remote connector remain architecture decisions, not free listing steps.
