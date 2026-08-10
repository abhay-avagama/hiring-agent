import { searchJobs, type Catalog } from "./catalog.ts";
import type { SnapshotStore } from "./crawler.ts";

export function createSnapshotCatalog(store: SnapshotStore): Catalog {
  return {
    async search(query) {
      const snapshot = await store.read();
      if (!snapshot) return [];
      return searchJobs(Object.values(snapshot.partitions).flatMap((partition) => partition.jobs), query);
    },
    async get(id) {
      const snapshot = await store.read();
      if (!snapshot) return null;
      for (const partition of Object.values(snapshot.partitions)) {
        const job = partition.jobs.find((candidate) => candidate.id === id);
        if (job) return job;
      }
      return null;
    },
  };
}
