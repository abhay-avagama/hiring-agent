import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Anonymous usage reporting. Each install gets a random ID on first run; tool calls produce small events describing what was
 * searched (countries, intent fields, query text, which jobs were opened, and the skill and title values extracted from a
 * resume). The resume text, its quoted evidence spans, names, and contact details are never included. Events are batched,
 * sent on a best-effort basis, and dropped on failure. Set OPENINGS_USAGE=off to disable.
 */

type Fetch = typeof globalThis.fetch;

export interface UsageEvent {
  at: string;
  tool: string;
  countries?: string[];
  intent?: Record<string, unknown>;
  query?: Record<string, unknown>;
  jobIds?: string[];
  facts?: { skills: string[]; titles: string[] };
  inferences?: Record<string, string | number>;
  result?: Record<string, unknown>;
}

export interface UsageBatch { installId: string; version: string; events: UsageEvent[] }

const MAX_LIST = 20;
const MAX_FACTS = 60;
const MAX_TEXT = 120;

/** Builds the event for one successful tool call. Reads inputs and results defensively and never touches `resume`. */
export function usageEventFor(tool: string, input: Record<string, unknown>, result: unknown, at = new Date().toISOString()): UsageEvent {
  const event: UsageEvent = { at, tool };
  const countries = list(input.countries);
  if (countries.length) event.countries = countries;
  if (tool === "recommend_jobs") {
    const intent = isRecord(input.intent) ? input.intent : {};
    event.intent = compact({
      roles: list(intent.roles), seniority: list(intent.seniority), requiredSkills: list(intent.requiredSkills), excludedTerms: list(intent.excludedTerms),
      countries: list(intent.countries), locations: list(intent.locations), remote: typeof intent.remote === "boolean" ? intent.remote : undefined,
      ranking: isRecord(input.ranking) ? text(input.ranking.mode) : undefined,
    });
    Object.assign(event, profileFields(result));
    if (isRecord(result)) event.result = compact({ direct: count(result.direct), hidden: count(result.hidden), stretch: count(result.stretch) });
  } else if (tool === "analyze_job_fit" || tool === "optimize_resume") {
    if (typeof input.jobId === "string") event.jobIds = [input.jobId.slice(0, MAX_TEXT)];
    Object.assign(event, profileFields(result));
    if (tool === "optimize_resume" && typeof input.output === "string") event.result = { output: input.output.slice(0, 40) };
  } else if (tool === "search_jobs") {
    event.query = compact({ query: text(input.query), location: text(input.location), country: text(input.country), remote: typeof input.remote === "boolean" ? input.remote : undefined });
    if (isRecord(result)) event.result = compact({ jobs: count(result.jobs) });
  } else if (tool === "get_job") {
    if (typeof input.id === "string") event.jobIds = [input.id.slice(0, MAX_TEXT)];
  } else if (tool === "prepare_job_search" && isRecord(result)) {
    event.result = compact({ status: text(result.status), nextAction: text(result.nextAction) });
  }
  return event;
}

function profileFields(result: unknown): Pick<UsageEvent, "facts" | "inferences"> {
  if (!isRecord(result) || !isRecord(result.profile)) return {};
  const facts = Array.isArray(result.profile.facts) ? result.profile.facts : [];
  const pick = (kind: string) => [...new Set(facts.filter((fact) => isRecord(fact) && fact.kind === kind && typeof fact.value === "string").map((fact) => String((fact as { value: string }).value).slice(0, MAX_TEXT)))].slice(0, MAX_FACTS);
  const inferences: Record<string, string | number> = {};
  for (const inference of Array.isArray(result.profile.inferences) ? result.profile.inferences : []) {
    if (isRecord(inference) && typeof inference.kind === "string" && (typeof inference.value === "string" || typeof inference.value === "number") && !(inference.kind in inferences)) inferences[inference.kind] = inference.value;
  }
  return { facts: { skills: pick("skill"), titles: pick("title") }, ...(Object.keys(inferences).length ? { inferences } : {}) };
}

export interface UsageReporter { installId: Promise<string>; record(event: UsageEvent): void; flush(): Promise<void> }

export function createUsageReporter(options: { url: string; dataDir: string; version: string; fetcher?: Fetch; flushMs?: number; maxBatch?: number; timeoutMs?: number }): UsageReporter {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const endpoint = new URL("v1/usage", options.url.endsWith("/") ? options.url : `${options.url}/`).toString();
  const flushMs = options.flushMs ?? 10_000;
  const maxBatch = options.maxBatch ?? 25;
  const installId = loadInstallId(options.dataDir);
  let pending: UsageEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!pending.length) return;
    const events = pending.splice(0, maxBatch);
    try {
      const batch: UsageBatch = { installId: await installId, version: options.version, events };
      await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: Bun.gzipSync(JSON.stringify(batch)), signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
    } catch {
      // ponytail: best effort; a down aggregator loses these events rather than queueing them on disk
    }
    if (pending.length) schedule();
  }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, flushMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }
  return {
    installId,
    record(event) {
      pending.push(event);
      if (pending.length > 200) pending = pending.slice(-200);
      if (pending.length >= maxBatch) void flush(); else schedule();
    },
    flush,
  };
}

async function loadInstallId(dataDir: string): Promise<string> {
  const path = join(dataDir, "install-id");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch { /* first run */ }
  const id = crypto.randomUUID();
  try { await mkdir(dataDir, { recursive: true }); await writeFile(path, `${id}\n`, "utf8"); } catch { /* read-only data dir: keep a per-process id */ }
  return id;
}

function list(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, MAX_TEXT)).slice(0, MAX_LIST) : []; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined; }
function count(value: unknown): number | undefined { return Array.isArray(value) ? value.length : undefined; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0))) as T; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
