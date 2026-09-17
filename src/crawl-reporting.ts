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
export function createCrawlReporter(options: { url: string; fetcher?: Fetch; timeoutMs?: number; attempts?: number; sleep?: (ms: number) => Promise<void> }) {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const target = endpoint(options.url, "v1/crawls");
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (source: Company, partition: JobPartition): Promise<void> => {
    const payload: CrawlReportPayload = { version: 1, source: { slug: source.slug, ats: source.ats, token: source.token }, fetchedAt: partition.fetchedAt, jobs: partition.jobs };
    const body = Bun.gzipSync(JSON.stringify(payload));
    let last: Error | undefined;
    // A crawl that ends while the aggregator is restarting used to lose its whole report in silence.
    // Retry the failures worth retrying: a refused connection, a timeout, or the server being briefly unwell.
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetcher(target, {
          method: "POST",
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
          body,
          // Big employers send tens of megabytes and the aggregator ingests one report at a time; give them room.
          signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
        });
        if (response.ok) return;
        // A rejected report will be rejected again: the catalog disagrees, or the payload is too large.
        if (response.status < 500) throw new Error(`Aggregator rejected crawl report: HTTP ${response.status}`);
        last = new Error(`Aggregator returned HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Aggregator rejected")) throw error;
        last = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < attempts) await sleep(attempt * 5_000);
    }
    throw last ?? new Error("Crawl report failed");
  };
}

/** Downloads the aggregator's published snapshot; returns null on any failure so setup falls back to crawling. */
export async function fetchSeedSnapshot(url: string, fetcher: Fetch = globalThis.fetch, timeoutMs = 20_000, countries: string[] = []): Promise<JobSnapshot | null> {
  try {
    const codes = countries.map((code) => code.toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
    const target = endpoint(url, "v1/snapshot") + (codes.length ? `?countries=${codes.join(",")}` : "");
    const response = await fetcher(target, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const snapshot = await response.json() as JobSnapshot;
    if (snapshot?.version !== 1 || !snapshot.partitions || typeof snapshot.partitions !== "object" || !snapshot.lastCrawl) return null;
    return snapshot;
  } catch {
    return null;
  }
}
