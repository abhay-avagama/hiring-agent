import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobSnapshot } from "./types.ts";

export interface SnapshotExportReport {
  outputDir: string;
  sources: number;
  jobs: number;
  countries: Record<string, number>;
  manifestPath: string;
}

export async function exportSnapshot(inputPath: string, outputDir: string): Promise<SnapshotExportReport> {
  const snapshot = JSON.parse(await readFile(inputPath, "utf8")) as JobSnapshot;
  if (snapshot.version !== 1 || !snapshot.partitions || typeof snapshot.partitions !== "object") throw new Error(`Unsupported snapshot format: ${inputPath}`);
  const sourceDir = join(outputDir, "sources");
  await mkdir(sourceDir, { recursive: true });
  const countries: Record<string, number> = {};
  const partitions = [];
  let jobCount = 0;

  for (const slug of Object.keys(snapshot.partitions).sort()) {
    const partition = snapshot.partitions[slug]!;
    const value = { source: slug, fetchedAt: partition.fetchedAt, jobs: [...partition.jobs].sort((left, right) => left.id.localeCompare(right.id)) };
    const content = stableJson(value);
    const path = `sources/${slug}.json`;
    await atomicWrite(join(outputDir, path), content);
    jobCount += value.jobs.length;
    for (const job of value.jobs) for (const country of job.eligibleCountries) countries[country] = (countries[country] ?? 0) + 1;
    partitions.push({ source: slug, path, jobs: value.jobs.length, sha256: sha256(content) });
  }

  const sortedCountries = Object.fromEntries(Object.entries(countries).sort(([left], [right]) => left.localeCompare(right)));
  const manifest = {
    version: 1,
    updatedAt: snapshot.updatedAt,
    sources: partitions.length,
    jobs: jobCount,
    countries: sortedCountries,
    partitions,
  };
  const manifestPath = join(outputDir, "manifest.json");
  await atomicWrite(manifestPath, stableJson(manifest));
  return { outputDir, sources: partitions.length, jobs: jobCount, countries: sortedCountries, manifestPath };
}

function stableJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
