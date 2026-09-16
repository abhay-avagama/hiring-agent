# Global catalog discovery

The goal is to discover substantially more career sources toward a **50,000 unique-board research target**, without representing discovered URLs as verified employers or active jobs. Existing catalog size is not a configured ceiling. New sources still require verification and successful job retrieval before they improve candidate-facing coverage.

## Implemented slice: resumable Common Crawl discovery

`sources discover-catalog` is a maintainer-only, global discovery command. It does not take a country: eligibility is determined from jobs later. The existing bounded `discover-common-crawl` command and its earlier campaign contracts are unchanged.

The new command:

- Requires explicit pinned index IDs and provider names; never chooses an implicit latest index.
- Queries only `https://index.commoncrawl.org`, refuses redirects, and does not fetch archived pages, ATS endpoints, or company websites.
- Uses the documented `showNumPages=true`, `pageSize=1`, and zero-based `page` contract. Page size means compressed index blocks, **not record count**. No `limit` is added to data pages, avoiding skipped records when advancing to the next block.
- Rotates queries by completed page count so one large provider/index need not exhaust the entire request allowance first. All query definitions are pinned in the checkpoint.
- Deduplicates canonical provider/token keys across pages and indexes while retaining every contributing index as discovery provenance. Distinct tokens are not automatically equated with distinct employers.
- Stores checkpoints, counters, and leads in a local `.sqlite` artifact under `.openings/`. Exports require `.json`, keeping database files separate from export lock/temporary sidecars. Each complete data page and its cursor are committed in one transaction. Malformed or oversized pages do not advance. Empty pages do advance when the page-count metadata says later pages remain. A structured HTTP 404 explicitly reporting no captures for the exact requested pattern is also an empty result; generic 404s still stop.
- Counts each request before dispatch, including failed requests and metadata queries. Process crashes may consume an attempt without committing a page; restart retries that page, without duplicate leads.
- Uses one request at a time, at least 1 second spacing (default 1.5 seconds), a 30-second timeout, and an 8 MiB response ceiling. Oversized pages require investigation, not silent truncation.
- Stops immediately on HTTP 429/503 and persists a cooldown of at least 15 minutes or the longer `Retry-After`. Other errors stop at the current checkpoint. There is no automatic retry loop.
- Has explicit per-invocation request/page budgets (defaults 100/80, maximum 1,000 each). Reinvoking with `--execute` authorizes another bounded chunk, not unlimited background work. Lifetime request totals remain visible.
- Treats `targetBoards` as a stopping milestone, not a promise or strict admission cap. It counts all deduplicated discoveries, including known catalog boards, and is checked between complete pages; the final page may overshoot it. No count implies reachability or current jobs.
- Makes no network requests without `--execute`. Planning may initialize/read the local checkpoint and optionally export already-discovered leads.

Checkpoint configurations cannot be changed on resume: use a new state file for different indexes/providers or changed query semantics. Budget, pacing, and target changes do not change query semantics. Completed campaigns issue zero further requests.

### Plan, then explicitly run

```sh
# Offline plan only. These pinned indexes are examples, not a claim of newest coverage.
bun run src/cli.ts sources discover-catalog \
  --index CC-MAIN-2026-30 --index CC-MAIN-2026-34 \
  --provider greenhouse --provider lever --provider ashby \
  --state .openings/global-discovery.sqlite \
  --request-budget 100 --page-budget 80 --target-boards 50000
```

After reviewing the scope, append `--execute` to run one chunk. Repeat the same command to resume. Structured output reports its stop reason, per-query progress, total/new/known board counts, raw records, rejected records, lifetime requests, and requests in this invocation. Error, throttled, and cooling-down results return a nonzero CLI exit code.

To export without networking, repeat the plan command with a **new** `--export .openings/global-leads-001.json` path. The output is an isolated `EnrichmentRegistry` suitable for a separately scoped verification batch. It excludes exact provider/token pairs already in `--catalog` (CLI default `data/companies.json`). It contains no identity evidence, company matches, verification attempts, or inferred geography. Existing exports are never overwritten, so subsequent verification outcomes cannot be erased by discovery.

No discovery operation writes `data/companies.json`, `data/source-candidates.json`, `data/enrichment-leads.json`, snapshots, or the hosted database. The discovery database is not a job store or a candidate-facing MCP dependency.

## Coverage expansion after this slice

1. Run bounded discovery chunks and inspect net-new board yield per provider/index.
2. Verify isolated exports with provider-aware pacing. Merge only explicitly selected results under the existing admission policy; board verification does not establish company-domain ownership.
3. Crawl newly admitted sources and measure distinct employers, usable descriptions, geography and roles. Website and MCP coverage rises only after indexing and deployment, not when discovery emits a URL.
4. Separately investigate missing providers such as Rippling, iCIMS, BambooHR, JazzHR, Jobvite and Oracle. A competitor supporting an ATS does not establish an acceptable public access contract for Openings.
5. For genuinely bulk index analysis, evaluate Common Crawl's columnar index rather than escalating load on its public CDX service. No paid query service or new provider integration is enabled by this change.

## Verification / execution record

Offline tests exercise cross-index deduplication, full-page pagination, restart budgets, empty pages, persistent cooldowns, malformed/oversized responses, known-source exclusion, export preservation, CLI validation, and a synthetic **50,000 distinct-board** input. This is a scalability regression fixture, not 50,000 real discovered boards.

No live discovery campaign, source verification, catalog expansion, or deployment has run as part of this implementation. The earlier 60-board recovery pilot remains unexecuted and is not the catalog expansion mechanism.

References checked 16 September 2026: [Common Crawl index server and load guidance](https://index.commoncrawl.org/), [documented CDX pagination](https://github.com/webrecorder/pywb/wiki/CDX-Server-API#pagination-api).
