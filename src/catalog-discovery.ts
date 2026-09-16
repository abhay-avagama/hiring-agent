import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertArtifactFile } from "./artifact-path.ts";
import { atomicJson } from "./atomic-file.ts";
import { commonCrawlPatterns } from "./common-crawl-discovery.ts";
import { withFileLock } from "./file-lock.ts";
import { resolveSource } from "./source-verification.ts";
import { ALL_PROVIDERS, type Ats } from "./types.ts";

interface Options {
  state: string; indexes: string[]; providers: Ats[]; execute?: boolean;
  requestBudget?: number; pageBudget?: number; targetBoards?: number; delayMs?: number;
  catalogPath?: string; exportPath?: string;
}
interface Dependencies {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
}
interface Query { id: number; index_id: string; provider: Ats; pattern: string; pages: number | null; next_page: number }
interface Board { key: string; ats: Ats; token: string; url: string }
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SCHEMA = 1;

/** Discovery only: fixed-host index requests, durable page checkpoints, no ATS probes or catalog writes. */
export async function discoverCatalog(options: Options, deps: Dependencies = {}) {
  // Distinct suffixes prevent SQLite files from aliasing the export's .lock or .PID.tmp sidecars.
  if (!options.state.endsWith(".sqlite")) throw Error("Discovery state must use a .sqlite filename");
  if (options.exportPath && !options.exportPath.endsWith(".json")) throw Error("Discovery export must use a .json filename");
  const indexes = [...new Set(options.indexes)].sort();
  const providers = [...new Set(options.providers)].sort();
  if (!indexes.length || indexes.length > 24 || indexes.some(id => !/^CC-MAIN-20\d{2}-\d{2}$/.test(id))) throw Error("Supply 1–24 pinned CC-MAIN-YYYY-NN index IDs");
  if (!providers.length || providers.some(p => !ALL_PROVIDERS.includes(p) || !commonCrawlPatterns(p)?.length)) throw Error("Supply supported providers with discovery patterns");
  const requests = integer(options.requestBudget ?? 100, 1, 1000, "requestBudget");
  const pages = integer(options.pageBudget ?? 80, 1, 1000, "pageBudget");
  const target = integer(options.targetBoards ?? 50000, 1, 1000000, "targetBoards");
  const delay = integer(options.delayMs ?? 1500, 1000, 60000, "delayMs");
  await assertArtifactFile(options.state);
  if (options.exportPath) {
    await assertArtifactFile(options.exportPath);
    if ([options.state, `${options.state}.lock`, `${options.state}-wal`, `${options.state}-shm`, `${options.state}-journal`, options.catalogPath].some(p => p && resolve(p) === resolve(options.exportPath!))) throw Error("Export must not overwrite state, lock, or catalog");
    if (await Bun.file(options.exportPath).exists()) throw Error("Export already exists; choose a new artifact path to preserve verification outcomes");
  }
  const known = new Set<string>();
  if (options.catalogPath) {
    const catalog = JSON.parse(await readFile(options.catalogPath, "utf8"));
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw Error("Invalid catalog");
    for (const entry of Object.values(catalog) as Array<{ ats: string; token: string }>) {
      if (typeof entry.ats !== "string" || typeof entry.token !== "string") throw Error("Invalid catalog entry");
      known.add(`${entry.ats}:${entry.token.toLowerCase()}`);
    }
  }
  const config = JSON.stringify({ schema: SCHEMA, indexes, providers, pageSize: 1, patterns: providers.map(p => [p, commonCrawlPatterns(p)]) });
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const fetcher = deps.fetch ?? globalThis.fetch;
  return withFileLock(options.state, async () => {
    const db = new Database(options.state);
    try {
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS queries (id INTEGER PRIMARY KEY, index_id TEXT NOT NULL, provider TEXT NOT NULL, pattern TEXT NOT NULL, pages INTEGER, next_page INTEGER NOT NULL DEFAULT 0, UNIQUE(index_id,pattern));
        CREATE TABLE IF NOT EXISTS boards (key TEXT PRIMARY KEY, ats TEXT NOT NULL, token TEXT NOT NULL, url TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS origins (board_key TEXT REFERENCES boards(key), query_id INTEGER REFERENCES queries(id), PRIMARY KEY(board_key,query_id));`);
      const get = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value;
      const put = (key: string, value: string | number) => db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
      if (get("config") && get("config") !== config) throw Error("Checkpoint configuration differs; use a new state file for different indexes/providers");
      if (!get("config")) db.transaction(() => {
        put("config", config);
        for (const index of indexes) for (const provider of providers) for (const pattern of commonCrawlPatterns(provider)) db.prepare("INSERT INTO queries(index_id,provider,pattern) VALUES (?,?,?)").run(index, provider, pattern);
      })();
      const boardCount = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM boards").get()!.n;
      let requestsThisRun = 0, pagesThisRun = 0;
      let status = options.execute ? "complete" : "plan";
      let error: string | undefined;
      if (options.execute) while (true) {
        const query = db.query<Query, []>("SELECT * FROM queries WHERE pages IS NULL OR next_page < pages ORDER BY next_page,id LIMIT 1").get();
        if (!query) break;
        if (Number(get("retryAt") ?? 0) > now()) { status = "cooling_down"; break; }
        if (boardCount() >= target) { status = "target_reached"; break; }
        if (requestsThisRun >= requests) { status = "request_budget"; break; }
        if (pagesThisRun >= pages) { status = "page_budget"; break; }
        const url = new URL(`https://index.commoncrawl.org/${query.index_id}-index`);
        url.search = new URLSearchParams({ url: query.pattern, output: "json", filter: "=status:200", fl: "url", pageSize: "1", ...(query.pages === null ? { showNumPages: "true" } : { page: String(query.next_page) }) }).toString();
        // Persist request accounting before dispatch: a process crash cannot erase a consumed attempt.
        await sleep(Math.max(delay, Number(get("lastRequestAt") ?? 0) + delay - now()));
        put("lastRequestAt", now()); put("requests", Number(get("requests") ?? 0) + 1); requestsThisRun++;
        try {
          const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30000), headers: { "user-agent": "OpeningsCatalogDiscovery/1.0" } });
          if (response.status === 429 || response.status === 503) {
            const header = response.headers.get("retry-after");
            const retry = header && /^\d+$/.test(header) ? now() + Number(header) * 1000 : Date.parse(header ?? "");
            put("retryAt", Math.max(now() + 15 * 60000, Number.isFinite(retry) ? retry : 0));
            await response.body?.cancel(); status = "throttled"; break;
          }
          if (response.status === 404) {
            const text = await boundedText(response);
            let message: unknown;
            try { const value = JSON.parse(text); message = value?.message ?? value?.error; } catch { /* Unknown 404s must not advance. */ }
            if (typeof message === "string" && message.toLowerCase() === `No Captures found for: ${query.pattern}`.toLowerCase()) {
              if (query.pages === null) db.prepare("UPDATE queries SET pages=0 WHERE id=?").run(query.id);
              else { db.prepare("UPDATE queries SET next_page=next_page+1 WHERE id=?").run(query.id); pagesThisRun++; }
              continue;
            }
            throw Error("Common Crawl HTTP 404");
          }
          if (!response.ok) { await response.body?.cancel(); throw Error(`Common Crawl HTTP ${response.status}`); }
          const body = await boundedText(response);
          if (query.pages === null) {
            const info = JSON.parse(body);
            if (!Number.isSafeInteger(info.pages) || info.pages < 0 || info.pages > 1000000 || info.pageSize !== 1) throw Error("Invalid CDX page count or pageSize");
            db.prepare("UPDATE queries SET pages=? WHERE id=?").run(info.pages, query.id);
          } else {
            const records = body.split(/\r?\n/).filter(line => line.trim());
            const additions: Board[] = []; let rejected = 0;
            for (const line of records) {
              const record: unknown = JSON.parse(line);
              if (!record || typeof record !== "object" || !("url" in record) || typeof record.url !== "string") throw Error("Malformed CDX URL record; page was not checkpointed");
              const source = resolveSource(record.url);
              if (!source || source.ats !== query.provider) { rejected++; continue; }
              additions.push({ key: `${source.ats}:${source.token.toLowerCase()}`, ats: source.ats, token: source.token, url: source.canonicalSourceUrl });
            }
            db.transaction(() => {
              for (const board of additions) {
                db.prepare("INSERT OR IGNORE INTO boards VALUES (?,?,?,?)").run(board.key, board.ats, board.token, board.url);
                db.prepare("INSERT OR IGNORE INTO origins VALUES (?,?)").run(board.key, query.id);
              }
              put("records", Number(get("records") ?? 0) + records.length);
              put("rejected", Number(get("rejected") ?? 0) + rejected);
              db.prepare("UPDATE queries SET next_page=next_page+1 WHERE id=?").run(query.id);
            })();
            pagesThisRun++;
          }
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); status = "error"; break; }
      }
      const boards = db.query<Board, []>("SELECT * FROM boards ORDER BY key").all();
      let exported: number | undefined;
      if (options.exportPath) {
        const origins = db.query<{ board_key: string; index_id: string }, []>("SELECT DISTINCT board_key,index_id FROM origins JOIN queries ON queries.id=origins.query_id ORDER BY board_key,index_id").all();
        const byKey = new Map<string, string[]>();
        for (const origin of origins) { const refs = byKey.get(origin.board_key) ?? []; refs.push(origin.index_id); byKey.set(origin.board_key, refs); }
        const leads = boards.filter(b => !known.has(b.key)).map(b => ({ sourceKey: b.key, ats: b.ats, token: b.token, sourceUrl: b.url, discoveredFrom: (byKey.get(b.key) ?? []).map(id => ({ channel: "dataset", reference: `https://index.commoncrawl.org/${id}-index` })), companyMatches: [], identityEvidence: [], attempts: [] }));
        await withFileLock(options.exportPath, async () => {
          if (await Bun.file(options.exportPath!).exists()) throw Error("Export already exists; choose a new artifact path");
          await atomicJson(options.exportPath!, { version: 1, updatedAt: new Date(now()).toISOString(), leads });
        }, { operation: "export discovery leads" }); exported = leads.length;
      }
      return { status, error, state: options.state, indexes, providers, boards: boards.length, knownBoards: boards.filter(b => known.has(b.key)).length, newBoardLeads: boards.filter(b => !known.has(b.key)).length,
        records: Number(get("records") ?? 0), rejectedRecords: Number(get("rejected") ?? 0), requestsTotal: Number(get("requests") ?? 0), requestsThisRun, pagesThisRun,
        retryAt: Number(get("retryAt") ?? 0) > now() ? new Date(Number(get("retryAt"))).toISOString() : undefined,
        limits: { requestBudget: requests, pageBudget: pages, targetBoards: target, delayMs: delay, maxResponseBytes: MAX_BODY_BYTES },
        queries: db.query<Query, []>("SELECT * FROM queries ORDER BY id").all(), exported,
        note: "Unverified discovery leads, not active boards or eligible employers. No catalog or shared registry was changed." };
    } finally { db.close(); }
  }, { operation: "catalog discovery" });
}

function integer(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let bytes = 0, text = "";
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw Error("CDX response exceeded byte limit; page was not checkpointed");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
