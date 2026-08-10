import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSnapshot } from "../src/snapshot-export.ts";
import type { JobSnapshot } from "../src/types.ts";

test("exports deterministic source partitions with checksums and country summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openings-export-"));
  const input = join(directory, "snapshot.json");
  const output = join(directory, "dist");
  const snapshot: JobSnapshot = {
    version: 1, updatedAt: "2026-08-10T00:00:00.000Z",
    partitions: { acme: { fetchedAt: "2026-08-10T00:00:00.000Z", jobs: [{ id: "greenhouse:acme:1", company: "Acme", title: "Engineer", location: "Pune, India", remote: false, workMode: "onsite", eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/1", description: "Build" }] } },
    lastCrawl: { startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:00:00.000Z", selected: 1, succeeded: 1, failed: [] },
  };
  await writeFile(input, JSON.stringify(snapshot));
  await mkdir(join(output, "sources"), { recursive: true });
  await writeFile(join(output, "sources/stale.json"), "{}");
  await writeFile(join(output, "manifest.json"), JSON.stringify({ partitions: [{ path: "sources/stale.json" }] }));

  const report = await exportSnapshot(input, output);
  const content = await readFile(join(output, "sources/acme.json"), "utf8");
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));

  expect(report).toEqual(expect.objectContaining({ sources: 1, jobs: 1, countries: { IN: 1 } }));
  expect(manifest.partitions[0]).toEqual({ source: "acme", path: "sources/acme.json", jobs: 1, sha256: createHash("sha256").update(content).digest("hex") });
  expect(access(join(output, "sources/stale.json"))).rejects.toThrow();
});
