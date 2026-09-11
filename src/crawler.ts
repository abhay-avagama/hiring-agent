import type { FetchJobsObserver } from "./catalog.ts";
import { statedExperience } from "./experience.ts";
import { partitionFor, type Company, type CrawlFailure, type CrawlReport, type CrawlSourceResult, type Job, type JobPartition, type JobSnapshot } from "./types.ts";

export interface SnapshotStore {
  read(): Promise<JobSnapshot | null>;
  write(snapshot: JobSnapshot): Promise<void>;
}

interface CrawlerOptions {
  store: SnapshotStore;
  fetchJobs(source: Company, signal?: AbortSignal, observer?: FetchJobsObserver): Promise<Job[]>;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  sourceStartDelayMs?: number;
  sourceFreshnessMs?: number;
  sourceLimit?: number;
  workdayPageDelayMs?: number;
  workdayCountries?: string[];
  /** Fetch a job's full description when its listing had none; used to read required experience. */
  describe?(source: Company, job: Job): Promise<string>;
  /** Only roles open to these countries, posted in the last 30 days, get a description fetch. Empty: none do. */
  describeCountries?: string[];
  pacingNow?: () => number;
  pacingSleep?: (delayMs: number) => Promise<void>;
  now?: () => Date;
  /** Called once per succeeded source after the snapshot is written; failures are swallowed so reporting never blocks a crawl. */
  onCrawled?(source: Company, partition: JobPartition): void | Promise<void>;
}

export interface Crawler {
  crawl(sources: Company[], settings?: { prune?: boolean }): Promise<CrawlReport>;
}

export function createCrawler(options: CrawlerOptions): Crawler {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 120_000));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 2));
  const sourceStartDelayMs = Math.max(0, Math.trunc(options.sourceStartDelayMs ?? 0));
  const sourceFreshnessMs = Math.max(0, Math.trunc(options.sourceFreshnessMs ?? 0));
  const sourceLimit = Math.max(0, Math.trunc(options.sourceLimit ?? 0));
  const now = options.now ?? (() => new Date());
  const pacingNow = options.pacingNow ?? Date.now;
  const pacingSleep = options.pacingSleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let previousStart: number | undefined;
  let pacingGate = Promise.resolve();
  const describeCountries = new Set(options.describeCountries ?? []);

  /** Required experience for every job: from its description, the last crawl's reading, or a paced detail fetch for recent roles in describeCountries. */
  async function withExperience(source: Company, jobs: Job[], previous: Job[] | undefined): Promise<Job[]> {
    const known = new Map((previous ?? []).filter((job) => job.experience !== undefined).map((job) => [job.id, job.experience]));
    const since = now().getTime() - 30 * 86_400_000;
    const deadline = Date.now() + DESCRIBE_BUDGET_MS;
    let budget = DESCRIBE_LIMIT;
    const out: Job[] = [];
    for (const job of jobs) {
      if (job.experience !== undefined) out.push(job);
      else if (job.description.trim()) out.push({ ...job, experience: statedExperience(job.description) });
      else if (known.has(job.id)) out.push({ ...job, experience: known.get(job.id) });
      else if (options.describe && budget > 0 && Date.now() < deadline && job.eligibleCountries.some((code) => describeCountries.has(code)) && Date.parse(job.updatedAt ?? "") >= since) {
        budget -= 1;
        try {
          if (options.workdayPageDelayMs) await pacingSleep(options.workdayPageDelayMs);
          const description = await options.describe(source, job);
          out.push(description.trim() ? { ...job, experience: statedExperience(description) } : job);
        } catch { out.push(job); } // unread; the next crawl tries again
      } else out.push(job);
    }
    return out;
  }

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
      const considered = sources.length;
      const cutoff = Date.parse(startedAt) - sourceFreshnessMs;
      const eligibleSources = (sourceFreshnessMs === 0 ? sources : sources.filter((source) => {
        const fetchedAt = Date.parse(partitionFor(partitions, source.slug)?.fetchedAt ?? "");
        return !Number.isFinite(fetchedAt) || fetchedAt <= cutoff;
      })).sort((left, right) => partitionTime(partitionFor(partitions, left.slug)?.fetchedAt) - partitionTime(partitionFor(partitions, right.slug)?.fetchedAt));
      const selectedSources = sourceLimit > 0 ? eligibleSources.slice(0, sourceLimit) : eligibleSources;
      let pending = selectedSources;
      let finalFailures: CrawlFailure[] = [];
      let succeeded = 0;
      const metrics = new Map<string, CrawlSourceResult>();
      for (const source of selectedSources) metrics.set(source.slug, { source: source.slug, status: "failed", attempts: 0, durationMs: 0, jobs: 0, countryJobs: {}, throttles: 0, backoffMs: 0 });

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
              const listed = await options.fetchJobs(source, controller.signal, {
                onBackoff: ({ status, delayMs }) => { metric.backoffMs += delayMs; if (status === 429) metric.throttles += 1; },
                workdayPageDelayMs: options.workdayPageDelayMs,
                workdayCountries: options.workdayCountries,
              });
              const jobs = await withExperience(source, listed, partitionFor(partitions, source.slug)?.jobs);
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

      const finishedAt = now().toISOString();
      const report: CrawlReport = {
        startedAt, finishedAt, considered, selected: selectedSources.length,
        cached: considered - eligibleSources.length, deferred: eligibleSources.length - selectedSources.length,
        succeeded, failed: finalFailures, sources: selectedSources.map((source) => metrics.get(source.slug)!),
      };
      await options.store.write({ version: 1, updatedAt: finishedAt, partitions, lastCrawl: report });
      if (options.onCrawled) {
        const crawled = selectedSources.filter((source) => metrics.get(source.slug)!.status === "succeeded");
        // Four at a time: sending a thousand reports at once made the largest ones time out while the aggregator queued them.
        let next = 0;
        const send = async () => { while (next < crawled.length) { const source = crawled[next++]!; await Promise.resolve().then(() => options.onCrawled!(source, partitions[source.slug]!)).catch(() => undefined); } };
        await Promise.all(Array.from({ length: Math.min(4, crawled.length) }, send));
      }
      return report;
    },
  };
}

// ponytail: per-source caps keep one crawl bounded; a big backlog (first run) drains over a few nights.
const DESCRIBE_LIMIT = 150;
const DESCRIBE_BUDGET_MS = 180_000;

function partitionTime(value: string | undefined): number {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function countCountries(jobs: Job[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const job of jobs) for (const country of job.eligibleCountries) counts[country] = (counts[country] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
