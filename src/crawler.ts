import type { Company, CrawlFailure, CrawlReport, Job, JobSnapshot } from "./types.ts";

export interface SnapshotStore {
  read(): Promise<JobSnapshot | null>;
  write(snapshot: JobSnapshot): Promise<void>;
}

interface CrawlerOptions {
  store: SnapshotStore;
  fetchJobs(source: Company): Promise<Job[]>;
  concurrency?: number;
  now?: () => Date;
}

export interface Crawler {
  crawl(sources: Company[]): Promise<CrawlReport>;
}

export function createCrawler(options: CrawlerOptions): Crawler {
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const now = options.now ?? (() => new Date());

  return {
    async crawl(sources) {
      const startedAt = now().toISOString();
      const previous = await options.store.read();
      const partitions = { ...(previous?.partitions ?? {}) };
      const failed: CrawlFailure[] = [];
      let succeeded = 0;
      let cursor = 0;

      async function worker() {
        while (cursor < sources.length) {
          const source = sources[cursor++];
          if (!source) continue;
          try {
            const jobs = await options.fetchJobs(source);
            partitions[source.slug] = { fetchedAt: now().toISOString(), jobs };
            succeeded += 1;
          } catch (error) {
            delete partitions[source.slug];
            failed.push({ source: source.slug, error: error instanceof Error ? error.message : String(error) });
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
