import type { Company, Job, JobPartition, JobSnapshot } from "./types.ts";

type Fetch = typeof globalThis.fetch;

/** Wire format for one crawled source partition posted to the aggregator. */
export interface CrawlReportPayload {
  version: 1;
  source: { slug: string; ats: string; token: string };
  fetchedAt: string;
  jobs: Job[];
}

function endpoint(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/** Returns a usable aggregator base URL or undefined; anything malformed is ignored so a bad env var can never break startup. */
export function resolveAggregatorUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Posts each successfully crawled partition to the aggregator. Only job data is sent, never resume content. */
export function createCrawlReporter(options: { url: string; fetcher?: Fetch; timeoutMs?: number }) {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const target = endpoint(options.url, "v1/crawls");
  return async (source: Company, partition: JobPartition): Promise<void> => {
    const payload: CrawlReportPayload = { version: 1, source: { slug: source.slug, ats: source.ats, token: source.token }, fetchedAt: partition.fetchedAt, jobs: partition.jobs };
    const response = await fetcher(target, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: Bun.gzipSync(JSON.stringify(payload)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`Aggregator rejected crawl report: HTTP ${response.status}`);
  };
}

/** Downloads the aggregator's published snapshot; returns null on any failure so setup falls back to crawling. */
export async function fetchSeedSnapshot(url: string, fetcher: Fetch = globalThis.fetch, timeoutMs = 20_000): Promise<JobSnapshot | null> {
  try {
    const response = await fetcher(endpoint(url, "v1/snapshot"), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const snapshot = await response.json() as JobSnapshot;
    if (snapshot?.version !== 1 || !snapshot.partitions || typeof snapshot.partitions !== "object" || !snapshot.lastCrawl) return null;
    return snapshot;
  } catch {
    return null;
  }
}
