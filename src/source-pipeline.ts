import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "./file-lock.ts";
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
  preserved: number;
  catalogPath: string;
  rejections: RejectedSource[];
}

export async function runSourceVerification(candidatesPath: string, catalogPath: string, options: PipelineOptions = {}): Promise<SourcePipelineReport> {
  await mkdir(dirname(catalogPath), { recursive: true });
  return withFileLock(catalogPath, () => runSourceVerificationUnlocked(candidatesPath, catalogPath, options));
}

async function runSourceVerificationUnlocked(candidatesPath: string, catalogPath: string, options: PipelineOptions): Promise<SourcePipelineReport> {
  const candidates = await readCandidates(candidatesPath);
  const result = await verifyCandidates(candidates, options);
  const prior = await readPriorCatalog(catalogPath);
  const freshlyVerified = new Set(result.verified.map((company) => company.slug));
  const verifiedDomains = new Set(result.verified.map((company) => company.companyDomain));
  const verifiedSources = new Set(result.verified.map((company) => `${company.ats}:${company.token.toLocaleLowerCase()}`));
  const preserved = result.rejected.flatMap((candidate) => {
    if (!(["unreachable", "invalid_payload", "empty_board"] as string[]).includes(candidate.reason)) return [];
    const slug = candidate.slug ?? slugFromDomain(candidate.companyDomain);
    if (freshlyVerified.has(slug)) return [];
    const previous = prior[slug];
    if (!previous || previous.companyDomain !== candidate.companyDomain.toLocaleLowerCase()) return [];
    if (verifiedDomains.has(previous.companyDomain) || verifiedSources.has(`${previous.ats}:${previous.token.toLocaleLowerCase()}`)) return [];
    return [{ slug, ...previous } as VerifiedCompany];
  });
  await writeCatalog(catalogPath, [...result.verified, ...preserved]);
  return {
    candidates: candidates.length,
    verified: result.verified.length,
    rejected: result.rejected.length,
    preserved: preserved.length,
    catalogPath,
    rejections: result.rejected,
  };
}

async function readPriorCatalog(path: string): Promise<Record<string, Omit<VerifiedCompany, "slug">>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, Omit<VerifiedCompany, "slug">> : {};
  } catch { return {}; }
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

function slugFromDomain(domain: string): string { return domain.toLocaleLowerCase().replace(/^www\./, "").split(".")[0]!.replace(/[^a-z0-9-]/g, "-"); }
