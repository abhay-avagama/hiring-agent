import { join } from "node:path";
import { fetchSourceJobs } from "./catalog.ts";
import { createCrawlReporter, fetchSeedSnapshot, resolveAggregatorUrl } from "./crawl-reporting.ts";
import { createUsageReporter, type UsageReporter } from "./usage.ts";
import { VERSION } from "./version.ts";
import { catalog as liveCatalog, companies } from "./index.ts";
import { createLocalJobs } from "./local-jobs.ts";
import { createJobRecommender } from "./job-recommendations.ts";
import { createJobFitAnalyzer } from "./job-fit-analysis.ts";
import { createResumeOptimizer } from "./resume-optimization.ts";
import { createSelectedJobLookup } from "./selected-job-lookup.ts";
import { createFileSnapshotStore } from "./snapshot-store.ts";
import { createJobCoverageReader } from "./job-coverage.ts";
import { createJobSearchPreparer } from "./job-search-preparation.ts";

export function createRuntime(options: { dataDir?: string; concurrency?: number; crawlDelayMs?: number; workdayPageDelayMs?: number; workdayCountries?: string[]; sourceCacheHours?: number; sourceLimit?: number } = {}) {
  const workdayCountries = options.workdayCountries ?? (process.env.OPENINGS_WORKDAY_COUNTRIES ?? "IN,US").split(",").map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
  const dataDir = options.dataDir ?? process.env.OPENINGS_DATA_DIR ?? join(process.cwd(), ".openings");
  const store = createFileSnapshotStore(join(dataDir, "snapshot.json"));
  const aggregatorUrl = resolveAggregatorUrl(process.env.OPENINGS_AGGREGATOR_URL);
  const onCrawled = aggregatorUrl ? createCrawlReporter({ url: aggregatorUrl }) : undefined;
  const usage: UsageReporter | undefined = aggregatorUrl && (process.env.OPENINGS_USAGE ?? "on").toLowerCase() !== "off" ? createUsageReporter({ url: aggregatorUrl, dataDir, version: VERSION }) : undefined;
  const local = createLocalJobs({
    sources: companies,
    store,
    fetchJobs: (source, signal, observer) => fetchSourceJobs(source, globalThis.fetch, signal, observer),
    concurrency: options.concurrency,
    sourceStartDelayMs: options.crawlDelayMs,
    sourceFreshnessMs: (options.sourceCacheHours ?? 0) * 60 * 60 * 1000,
    sourceLimit: options.sourceLimit,
    workdayPageDelayMs: options.workdayPageDelayMs,
    workdayCountries,
    onCrawled,
  });
  const recommender = createJobRecommender({ sources: companies, store, crawl: local.crawl });
  const coverage = createJobCoverageReader({ sources: companies, store });
  const preparationLocal = createLocalJobs({
    sources: companies,
    store,
    fetchJobs: (source, signal, observer) => fetchSourceJobs(source, globalThis.fetch, signal, observer),
    concurrency: options.concurrency,
    timeoutMs: 90_000,
    maxAttempts: 1,
    sourceStartDelayMs: options.crawlDelayMs,
    workdayPageDelayMs: options.workdayPageDelayMs,
    workdayCountries,
    onCrawled,
  });
  const preparation = createJobSearchPreparer({ sources: companies, store, crawl: preparationLocal.crawl, seed: aggregatorUrl ? (countries) => fetchSeedSnapshot(aggregatorUrl, globalThis.fetch, 20_000, countries) : undefined });
  const getSelectedJob = createSelectedJobLookup({
    getSnapshotJob: async (id) => (await local.get(id, { offline: true, staleDays: 14 })).job,
    getDetailedJob: (id) => liveCatalog.get(id),
  });
  const analyzer = createJobFitAnalyzer({ getJob: getSelectedJob });
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  return { ...local, prepareJobSearch: preparation.prepare, getJobCoverage: coverage.getCoverage, recommend: recommender.recommend, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize, usage };
}
