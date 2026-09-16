import type { Job } from "./types.ts";
import { normalizeJobExperience } from "./experience.ts";

export interface SelectedJobLookupOptions {
  getSnapshotJob(id: string): Promise<Job | null>;
  getDetailedJob(id: string): Promise<Job | null>;
}

export function createSelectedJobLookup(options: SelectedJobLookupOptions) {
  return async (id: string): Promise<Job | null> => {
    const snapshot = await options.getSnapshotJob(id);
    if (snapshot?.description.trim()) return normalizeJobExperience(snapshot);
    const detailed = await options.getDetailedJob(id);
    return detailed ? normalizeJobExperience(detailed) : null;
  };
}
