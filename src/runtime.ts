import { join } from "node:path";
import { fetchSourceJobs } from "./catalog.ts";
import { catalog as liveCatalog, companies } from "./index.ts";
import { createLocalJobs } from "./local-jobs.ts";
import { createJobRecommender } from "./job-recommendations.ts";
import { createJobFitAnalyzer } from "./job-fit-analysis.ts";
import { createResumeOptimizer } from "./resume-optimization.ts";
import { createSelectedJobLookup } from "./selected-job-lookup.ts";
import { createFileSnapshotStore } from "./snapshot-store.ts";
import { createJobCoverageReader } from "./job-coverage.ts";
import { createJobSearchPreparer } from "./job-search-preparation.ts";

export function createRuntime(options: { dataDir?: string; concurrency?: number; crawlDelayMs?: number; workdayPageDelayMs?: number; sourceCacheHours?: number; sourceLimit?: number } = {}) {
  const dataDir = options.dataDir ?? process.env.OPENINGS_DATA_DIR ?? join(process.cwd(), ".openings");
  const store = createFileSnapshotStore(join(dataDir, "snapshot.json"));
  const local = createLocalJobs({
    sources: companies,
    store,
    fetchJobs: (source, signal, observer) => fetchSourceJobs(source, globalThis.fetch, signal, observer),
    concurrency: options.concurrency,
    sourceStartDelayMs: options.crawlDelayMs,
    sourceFreshnessMs: (options.sourceCacheHours ?? 0) * 60 * 60 * 1000,
    sourceLimit: options.sourceLimit,
    workdayPageDelayMs: options.workdayPageDelayMs,
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
  });
  const preparation = createJobSearchPreparer({ sources: companies, store, crawl: preparationLocal.crawl });
  const getSelectedJob = createSelectedJobLookup({
    getSnapshotJob: async (id) => (await local.get(id, { offline: true, staleDays: 14 })).job,
    getDetailedJob: (id) => liveCatalog.get(id),
  });
  const analyzer = createJobFitAnalyzer({ getJob: getSelectedJob });
  const optimizer = createResumeOptimizer({ analyzeJobFit: analyzer.analyze });
  return { ...local, prepareJobSearch: preparation.prepare, getJobCoverage: coverage.getCoverage, recommend: recommender.recommend, analyzeJobFit: analyzer.analyze, optimizeResume: optimizer.optimize };
}
