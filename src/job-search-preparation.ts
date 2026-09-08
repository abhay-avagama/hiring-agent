import type { SnapshotStore } from "./crawler.ts";
import { projectJobCoverage, type JobCoverageSummary } from "./job-coverage.ts";
import type { CrawlScope } from "./local-jobs.ts";
import { partitionFor, type Company, type CrawlReport, type JobSnapshot } from "./types.ts";

export interface PrepareJobSearchResult {
  status: "ready" | "partial";
  nextAction: "ready" | "call_again" | "retry_later";
  note?: string;
  continuation?: string;
  networkAttempted: boolean;
  sources: { catalog: number; indexed: number; fresh: number; stale: number; missing: number; pending: number };
  coverage: JobCoverageSummary;
  crawl?: Pick<CrawlReport, "selected" | "succeeded" | "failed">;
}

export function createJobSearchPreparer(options: {
  sources: Company[];
  store: SnapshotStore;
  crawl(scope: CrawlScope): Promise<CrawlReport>;
  /** Optional published snapshot used instead of crawling when no local snapshot exists yet. */
  seed?(countries: string[]): Promise<JobSnapshot | null>;
  now?: () => Date;
  freshnessDays?: number;
  batchSize?: number;
}) {
  const now = options.now ?? (() => new Date());
  const freshnessMs = (options.freshnessDays ?? 14) * 86_400_000;
  const batchSize = Math.max(1, Math.min(25, Math.trunc(options.batchSize ?? 25)));
  return {
    async prepare(value: unknown): Promise<PrepareJobSearchResult> {
      const input = validateInput(value, options.sources);
      const { countries } = input;
      let snapshot = await options.store.read();
      if (!snapshot && options.seed) {
        const seeded = await options.seed(countries).catch(() => null);
        if (seeded) { await options.store.write(seeded); snapshot = seeded; }
      }
      const pendingBefore = pendingSources(options.sources, snapshot, now(), freshnessMs);
      const selected = pendingBefore.filter((source) => !input.attempted.has(source.slug)).slice(0, batchSize).map((source) => source.slug);
      const crawl = selected.length ? await options.crawl({ slugs: selected }) : undefined;
      if (crawl) snapshot = await options.store.read();
      if (!snapshot) throw new Error("Job search preparation did not produce a local snapshot");

      const state = sourceState(options.sources, snapshot, now(), freshnessMs);
      const attempted = new Set([...input.attempted, ...selected]);
      const hasUnattemptedPending = pendingSources(options.sources, snapshot, now(), freshnessMs).some((source) => !attempted.has(source.slug));
      // The shared seed normally covers the whole catalog on the first call; a few missing or stale sources never justify another round trip.
      const covered = state.fresh / Math.max(1, options.sources.length);
      const nextAction = state.pending === 0 || covered >= 0.95 ? "ready" : hasUnattemptedPending ? "call_again" : "retry_later";
      return {
        status: state.pending === 0 ? "ready" : "partial",
        nextAction,
        ...(nextAction === "ready" && state.pending > 0 ? { note: `${state.indexed} of ${options.sources.length} sources are indexed; the remaining ${state.pending} are optional and refresh in the background of later calls.` } : {}),
        ...(nextAction === "call_again" ? { continuation: encodeContinuation(countries, attempted) } : {}),
        networkAttempted: Boolean(crawl),
        sources: { catalog: options.sources.length, ...state },
        coverage: projectJobCoverage(options.sources, snapshot, countries),
        ...(crawl ? { crawl: { selected: crawl.selected, succeeded: crawl.succeeded, failed: crawl.failed } } : {}),
      };
    },
  };
}

function pendingSources(sources: Company[], snapshot: Awaited<ReturnType<SnapshotStore["read"]>>, now: Date, freshnessMs: number): Company[] {
  const cutoff = now.getTime() - freshnessMs;
  return sources.filter((source) => {
    const fetchedAt = Date.parse((snapshot && partitionFor(snapshot.partitions, source.slug))?.fetchedAt ?? "");
    return !Number.isFinite(fetchedAt) || fetchedAt < cutoff;
  });
}

function sourceState(sources: Company[], snapshot: NonNullable<Awaited<ReturnType<SnapshotStore["read"]>>>, now: Date, freshnessMs: number) {
  const cutoff = now.getTime() - freshnessMs;
  let missing = 0;
  let stale = 0;
  for (const source of sources) {
    const partition = partitionFor(snapshot.partitions, source.slug);
    if (!partition) missing += 1;
    else {
      const fetchedAt = Date.parse(partition.fetchedAt);
      if (!Number.isFinite(fetchedAt) || fetchedAt < cutoff) stale += 1;
    }
  }
  const indexed = sources.length - missing;
  return { indexed, fresh: indexed - stale, stale, missing, pending: stale + missing };
}

function validateInput(value: unknown, sources: Company[]): { countries: string[]; attempted: Set<string> } {
  if (!isRecord(value)) throw new Error("prepare_job_search input must be an object");
  const unknown = Object.keys(value).find((key) => key !== "countries" && key !== "continuation");
  if (unknown) throw new Error(`prepare_job_search does not accept field: ${unknown}`);
  if (!Array.isArray(value.countries) || value.countries.length === 0 || value.countries.length > 20) {
    throw new Error("prepare_job_search requires between 1 and 20 countries");
  }
  if (!value.countries.every((country) => typeof country === "string" && /^[a-z]{2}$/iu.test(country))) {
    throw new Error("countries must contain only two-letter country codes");
  }
  const countries = [...new Set(value.countries.map((country) => String(country).toUpperCase()))];
  if (value.continuation === undefined) return { countries, attempted: new Set() };
  if (typeof value.continuation !== "string" || value.continuation.length > 16_384) throw new Error("continuation must be a valid preparation token");
  try {
    const parsed = JSON.parse(Buffer.from(value.continuation, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.countries) || !Array.isArray(parsed.attempted)) throw new Error("invalid");
    if (JSON.stringify(parsed.countries) !== JSON.stringify(countries)) throw new Error("country mismatch");
    const known = new Set(sources.map((source) => source.slug));
    if (!parsed.attempted.every((slug) => typeof slug === "string" && known.has(slug))) throw new Error("unknown source");
    return { countries, attempted: new Set(parsed.attempted as string[]) };
  } catch {
    throw new Error("continuation must be a valid preparation token for the requested countries");
  }
}

function encodeContinuation(countries: string[], attempted: Set<string>): string {
  return Buffer.from(JSON.stringify({ version: 1, countries, attempted: [...attempted].sort() }), "utf8").toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
