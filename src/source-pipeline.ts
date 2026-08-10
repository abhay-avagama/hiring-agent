import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyCandidates } from "./source-verification.ts";
import type { RejectedSource, SourceCandidate, VerifiedCompany } from "./types.ts";

interface PipelineOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  concurrency?: number;
  timeoutMs?: number;
}

export interface SourcePipelineReport {
  candidates: number;
  verified: number;
  rejected: number;
  catalogPath: string;
  rejections: RejectedSource[];
}

export async function runSourceVerification(candidatesPath: string, catalogPath: string, options: PipelineOptions = {}): Promise<SourcePipelineReport> {
  const candidates = await readCandidates(candidatesPath);
  const result = await verifyCandidates(candidates, options);
  await writeCatalog(catalogPath, result.verified);
  return {
    candidates: candidates.length,
    verified: result.verified.length,
    rejected: result.rejected.length,
    catalogPath,
    rejections: result.rejected,
  };
}

async function readCandidates(path: string): Promise<SourceCandidate[]> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read candidate file ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(value) || !value.every((candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))) {
    throw new Error("Candidate file must contain a JSON array of objects");
  }
  return value as SourceCandidate[];
}

async function writeCatalog(path: string, companies: VerifiedCompany[]): Promise<void> {
  const catalog = Object.fromEntries(companies.sort((a, b) => a.slug.localeCompare(b.slug)).map(({ slug, ...company }) => [slug, company]));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  await rename(temporary, path);
}
