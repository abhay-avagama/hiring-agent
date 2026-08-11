import type { Company, CrawlFailure, CrawlReport, CrawlSourceResult, Job, JobSnapshot } from "./types.ts";

export interface SnapshotStore {
  read(): Promise<JobSnapshot | null>;
  write(snapshot: JobSnapshot): Promise<void>;
}

interface CrawlerOptions {
  store: SnapshotStore;
  fetchJobs(source: Company, signal?: AbortSignal, observer?: { onBackoff(event: { status: number; delayMs: number }): void }): Promise<Job[]>;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  sourceStartDelayMs?: number;
  pacingNow?: () => number;
  pacingSleep?: (delayMs: number) => Promise<void>;
  now?: () => Date;
}

export interface Crawler {
  crawl(sources: Company[], settings?: { prune?: boolean }): Promise<CrawlReport>;
}

export function createCrawler(options: CrawlerOptions): Crawler {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 120_000));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 2));
  const sourceStartDelayMs = Math.max(0, Math.trunc(options.sourceStartDelayMs ?? 0));
  const now = options.now ?? (() => new Date());
  const pacingNow = options.pacingNow ?? Date.now;
  const pacingSleep = options.pacingSleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let previousStart: number | undefined;
  let pacingGate = Promise.resolve();

  async function paceSourceStart() {
    if (!sourceStartDelayMs) return;
    let release!: () => void;
    const previous = pacingGate;
    pacingGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const remaining = previousStart === undefined ? 0 : previousStart + sourceStartDelayMs - pacingNow();
      if (remaining > 0) await pacingSleep(remaining);
      previousStart = pacingNow();
    } finally { release(); }
  }

  return {
    async crawl(sources, settings) {
      const startedAt = now().toISOString();
      const previous = await options.store.read();
      const partitions = { ...(previous?.partitions ?? {}) };
      if (settings?.prune) {
        const current = new Set(sources.map((source) => source.slug));
        for (const slug of Object.keys(partitions)) if (!current.has(slug)) delete partitions[slug];
      }
      let pending = sources;
      let finalFailures: CrawlFailure[] = [];
      let succeeded = 0;
      const metrics = new Map<string, CrawlSourceResult>();
      for (const source of sources) metrics.set(source.slug, { source: source.slug, status: "failed", attempts: 0, durationMs: 0, jobs: 0, countryJobs: {}, throttles: 0, backoffMs: 0 });

      for (let attempt = 1; attempt <= maxAttempts && pending.length; attempt += 1) {
        let cursor = 0;
        const retry: Company[] = [];
        const failures: CrawlFailure[] = [];

        async function worker() {
          while (cursor < pending.length) {
            const source = pending[cursor++];
            if (!source) continue;
            await paceSourceStart();
            const metric = metrics.get(source.slug)!;
            metric.attempts += 1;
            const attemptStartedAt = Date.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
            try {
              const jobs = await options.fetchJobs(source, controller.signal, { onBackoff: ({ status, delayMs }) => { metric.backoffMs += delayMs; if (status === 429) metric.throttles += 1; } });
              partitions[source.slug] = { fetchedAt: now().toISOString(), jobs };
              succeeded += 1;
              metric.status = "succeeded";
              metric.jobs = jobs.length;
              metric.countryJobs = countCountries(jobs);
              delete metric.error;
            } catch (error) {
              retry.push(source);
              const message = error instanceof Error ? error.message : String(error);
              failures.push({ source: source.slug, error: message });
              metric.error = message;
            } finally {
              metric.durationMs += Date.now() - attemptStartedAt;
              clearTimeout(timer);
            }
          }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
        pending = retry;
        finalFailures = failures;
      }

      for (const failure of finalFailures) delete partitions[failure.source];
      const finishedAt = now().toISOString();
      const report: CrawlReport = { startedAt, finishedAt, selected: sources.length, succeeded, failed: finalFailures, sources: sources.map((source) => metrics.get(source.slug)!) };
      await options.store.write({ version: 1, updatedAt: finishedAt, partitions, lastCrawl: report });
      return report;
    },
  };
}

function countCountries(jobs: Job[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) for (const country of job.eligibleCountries) counts[country] = (counts[country] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
