import { join } from "node:path";
import { fetchSourceJobs } from "./catalog.ts";
import { companies } from "./index.ts";
import { createLocalJobs } from "./local-jobs.ts";
import { createFileSnapshotStore } from "./snapshot-store.ts";

export function createRuntime(options: { dataDir?: string; concurrency?: number } = {}) {
  const dataDir = options.dataDir ?? process.env.OPENINGS_DATA_DIR ?? join(process.cwd(), ".openings");
  return createLocalJobs({
    sources: companies,
    store: createFileSnapshotStore(join(dataDir, "snapshot.json")),
    fetchJobs: (source, signal) => fetchSourceJobs(source, globalThis.fetch, signal),
    concurrency: options.concurrency,
  });
}
