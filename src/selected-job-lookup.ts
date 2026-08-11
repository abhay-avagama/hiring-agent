import type { Job } from "./types.ts";

export interface SelectedJobLookupOptions {
  getSnapshotJob(id: string): Promise<Job | null>;
  getDetailedJob(id: string): Promise<Job | null>;
}

export function createSelectedJobLookup(options: SelectedJobLookupOptions) {
  return async (id: string): Promise<Job | null> => {
    const snapshot = await options.getSnapshotJob(id);
    if (snapshot?.description.trim()) return snapshot;
    return options.getDetailedJob(id);
  };
}
