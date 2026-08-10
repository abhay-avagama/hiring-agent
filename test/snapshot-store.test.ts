import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileSnapshotStore } from "../src/snapshot-store.ts";
import type { JobSnapshot } from "../src/types.ts";

test("file snapshot store round-trips a snapshot and treats a missing file as empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-store-"));
  const store = createFileSnapshotStore(join(directory, "nested", "snapshot.json"));
  expect(await store.read()).toBeNull();
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-10T00:00:00.000Z", partitions: {},
    lastCrawl: { startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:00:00.000Z", selected: 0, succeeded: 0, failed: [] },
  };

  await store.write(snapshot);

  expect(await store.read()).toEqual(snapshot);
});
