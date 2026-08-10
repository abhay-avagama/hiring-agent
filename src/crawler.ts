import type { Company, CrawlFailure, CrawlReport, Job, JobSnapshot } from "./types.ts";

export interface SnapshotStore {
  read(): Promise<JobSnapshot | null>;
  write(snapshot: JobSnapshot): Promise<void>;
}

interface CrawlerOptions {
  store: SnapshotStore;
  fetchJobs(source: Company, signal?: AbortSignal): Promise<Job[]>;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export interface Crawler {
  crawl(sources: Company[], settings?: { prune?: boolean }): Promise<CrawlReport>;
}

export function createCrawler(options: CrawlerOptions): Crawler {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
  const now = options.now ?? (() => new Date());

  return {
    async crawl(sources, settings) {
      const startedAt = now().toISOString();
      const previous = await options.store.read();
      const partitions = { ...(previous?.partitions ?? {}) };
      if (settings?.prune) {
        const current = new Set(sources.map((source) => source.slug));
        for (const slug of Object.keys(partitions)) if (!current.has(slug)) delete partitions[slug];
      }
      const failed: CrawlFailure[] = [];
      let succeeded = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < sources.length) {
          const source = sources[cursor++];
          if (!source) continue;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
          try {
            const jobs = await options.fetchJobs(source, controller.signal);
            partitions[source.slug] = { fetchedAt: now().toISOString(), jobs };
            succeeded += 1;
          } catch (error) {
            delete partitions[source.slug];
            failed.push({ source: source.slug, error: error instanceof Error ? error.message : String(error) });
          } finally {
            clearTimeout(timer);
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
      const finishedAt = now().toISOString();
      const report: CrawlReport = { startedAt, finishedAt, selected: sources.length, succeeded, failed };
      await options.store.write({ version: 1, updatedAt: finishedAt, partitions, lastCrawl: report });
      return report;
    },
  };
}
