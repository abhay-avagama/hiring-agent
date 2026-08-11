import { join } from "node:path";
import { fetchSourceJobs } from "./catalog.ts";
import { companies } from "./index.ts";
import { createLocalJobs } from "./local-jobs.ts";
import { createJobRecommender } from "./job-recommendations.ts";
import { createJobFitAnalyzer } from "./job-fit-analysis.ts";
import { createFileSnapshotStore } from "./snapshot-store.ts";

export function createRuntime(options: { dataDir?: string; concurrency?: number } = {}) {
  const dataDir = options.dataDir ?? process.env.OPENINGS_DATA_DIR ?? join(process.cwd(), ".openings");
  const store = createFileSnapshotStore(join(dataDir, "snapshot.json"));
  const local = createLocalJobs({
    sources: companies,
    store,
    fetchJobs: (source, signal, observer) => fetchSourceJobs(source, globalThis.fetch, signal, observer),
    concurrency: options.concurrency,
  });
  const recommender = createJobRecommender({ sources: companies, store, crawl: local.crawl });
  const analyzer = createJobFitAnalyzer({ getJob: async (id) => (await local.get(id, { offline: true, staleDays: 14 })).job });
  return { ...local, recommend: recommender.recommend, analyzeJobFit: analyzer.analyze };
}
