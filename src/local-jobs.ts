import type { FetchJobsObserver } from "./catalog.ts";
import { createCrawler, type SnapshotStore } from "./crawler.ts";
import { createSnapshotCatalog } from "./snapshot-catalog.ts";
import type { Company, CrawlReport, Job, JobSnapshot, JobSummary, SearchQuery } from "./types.ts";

interface LocalJobsOptions {
  sources: Company[];
  store: SnapshotStore;
  fetchJobs(source: Company, signal?: AbortSignal, observer?: FetchJobsObserver): Promise<Job[]>;
  concurrency?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  sourceStartDelayMs?: number;
  sourceFreshnessMs?: number;
  sourceLimit?: number;
  workdayPageDelayMs?: number;
  now?: () => Date;
}

export interface CrawlScope {
  country?: string;
  countries?: string[];
  slugs?: string[];
}

export interface SnapshotStatus {
  updatedAt: string;
  ageDays: number;
  stale: boolean;
  refreshed: boolean;
  sources: number;
  jobs: number;
  failures: number;
}

export function createLocalJobs(options: LocalJobsOptions) {
  const now = options.now ?? (() => new Date());
  const crawler = createCrawler({ ...options, now });
  const catalog = createSnapshotCatalog(options.store);

  async function crawl(scope: CrawlScope = {}): Promise<CrawlReport> {
    const selected = selectSources(options.sources, scope);
    return crawler.crawl(selected, { prune: !scope.country && !scope.countries && !scope.slugs });
  }

  async function ensureFresh(offline: boolean, staleDays: number): Promise<{ snapshot: JobSnapshot; refreshed: boolean }> {
    let snapshot = await options.store.read();
    const stale = !snapshot || snapshotIsStale(snapshot, staleDays, now());
    if (stale && !offline) {
      await crawl();
      snapshot = await options.store.read();
      if (!snapshot) throw new Error("Crawl completed without producing a snapshot");
      return { snapshot, refreshed: true };
    }
    if (!snapshot) throw new Error("No local snapshot. Run `openings crawl` or search without --offline.");
    return { snapshot, refreshed: false };
  }

  return {
    crawl,
    async search(query: SearchQuery, settings: { offline: boolean; staleDays: number }): Promise<{ jobs: JobSummary[]; snapshot: SnapshotStatus }> {
      const ready = await ensureFresh(settings.offline, settings.staleDays);
      return { jobs: await catalog.search(query), snapshot: snapshotStatus(ready.snapshot, settings.staleDays, now(), ready.refreshed) };
    },
    async get(id: string, settings: { offline: boolean; staleDays: number }): Promise<{ job: Job | null; snapshot: SnapshotStatus }> {
      const ready = await ensureFresh(settings.offline, settings.staleDays);
      return { job: await catalog.get(id), snapshot: snapshotStatus(ready.snapshot, settings.staleDays, now(), ready.refreshed) };
    },
    ensureFresh,
    catalog,
  };
}

function selectSources(sources: Company[], scope: CrawlScope): Company[] {
  if (scope.slugs) {
    const wanted = new Set(scope.slugs);
    const selected = sources.filter((source) => wanted.has(source.slug));
    const missing = [...wanted].filter((slug) => !selected.some((source) => source.slug === slug));
    if (missing.length) throw new Error(`Unknown company source(s): ${missing.join(", ")}`);
    return selected;
  }
  if (scope.country) {
    const country = scope.country.toUpperCase();
    return sources.filter((source) => source.cohorts?.includes(country));
  }
  if (scope.countries) {
    const countries = new Set(scope.countries.map((country) => country.toUpperCase()));
    return sources.filter((source) => source.cohorts?.some((country) => countries.has(country)));
  }
  return sources;
}

export function snapshotIsStale(snapshot: JobSnapshot, staleDays: number, now: Date): boolean {
  const timestamps = Object.values(snapshot.partitions).map((partition) => Date.parse(partition.fetchedAt));
  if (timestamps.length === 0) return true;
  const oldest = Math.min(...timestamps);
  return now.getTime() - oldest > staleDays * 86_400_000;
}

export function snapshotStatus(snapshot: JobSnapshot, staleDays: number, now: Date, refreshed: boolean): SnapshotStatus {
  const timestamps = Object.values(snapshot.partitions).map((partition) => Date.parse(partition.fetchedAt));
  const oldest = timestamps.length ? Math.min(...timestamps) : Date.parse(snapshot.updatedAt);
  return {
    updatedAt: snapshot.updatedAt,
    ageDays: Math.max(0, Math.floor((now.getTime() - oldest) / 86_400_000)),
    stale: snapshotIsStale(snapshot, staleDays, now),
    refreshed,
    sources: Object.keys(snapshot.partitions).length,
    jobs: Object.values(snapshot.partitions).reduce((sum, partition) => sum + partition.jobs.length, 0),
    failures: snapshot.lastCrawl.failed.length,
  };
}
