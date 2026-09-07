import { promises as dns } from "node:dns";
import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";

/**
 * Passive careers-subdomain discovery. For each company domain it reads certificate transparency logs (no requests to the
 * company) plus a short conventional list, keeps names that look like a careers host, confirms each resolves in DNS, and
 * emits tracer seeds. The career tracer then makes the single safe HEAD request that turns a subdomain into a board.
 * Never brute-forces names and never fetches a page.
 */

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Resolve = (hostname: string) => Promise<string[]>;

export interface SubdomainSeed { companyName: string; companyDomain: string }
export interface SubdomainDiscoveryReport {
  generatedAt: string;
  companies: number;
  certificateNames: number;
  candidates: number;
  resolved: number;
  seeds: Array<SubdomainSeed & { careerUrl: string; via: "certificate_transparency" | "conventional_name" }>;
  failures: Array<{ companyDomain: string; reason: "ct_request_failed" | "invalid_domain"; detail: string }>;
  outputPath: string;
}

const CAREER_WORDS = new Set(["careers", "career", "jobs", "job", "apply", "hiring", "talent", "talents", "recruit", "recruiting", "recruitment", "join", "joinus", "workwithus", "opportunities", "vacancies", "openings"]);
const CONVENTIONAL = ["careers", "jobs", "apply", "hiring", "talent", "recruit", "join"];

/** True when the subdomain part (everything before the company domain) reads like a careers host. */
export function looksLikeCareersHost(subdomain: string): boolean {
  const words = subdomain.toLowerCase().split(/[.-]+/).filter(Boolean);
  return words.some((word) => CAREER_WORDS.has(word)) || (words.includes("work") && words.includes("us"));
}

export async function discoverCareerSubdomains(seedsPath: string, outputPath: string, options: { fetch?: Fetch; resolve?: Resolve; now?: () => Date; limit?: number; delayMs?: number } = {}): Promise<SubdomainDiscoveryReport> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const resolve = options.resolve ?? (async (hostname: string) => { try { return await dns.resolve(hostname, "A"); } catch { try { return await dns.resolve(hostname, "CNAME"); } catch { return []; } } });
  const now = options.now ?? (() => new Date());
  const delayMs = Math.max(0, options.delayMs ?? 1_000);
  const seeds = (await readSeeds(seedsPath)).slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  const report: SubdomainDiscoveryReport = { generatedAt: now().toISOString(), companies: seeds.length, certificateNames: 0, candidates: 0, resolved: 0, seeds: [], failures: [], outputPath };

  for (const [index, seed] of seeds.entries()) {
    const domain = seed.companyDomain.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) { report.failures.push({ companyDomain: seed.companyDomain, reason: "invalid_domain", detail: "companyDomain must be a hostname" }); continue; }
    const candidates = new Map<string, "certificate_transparency" | "conventional_name">();
    for (const name of CONVENTIONAL) candidates.set(`${name}.${domain}`, "conventional_name");
    try {
      if (index > 0 && delayMs) await new Promise((done) => setTimeout(done, delayMs));
      const names = await certificateNames(domain, fetcher);
      report.certificateNames += names.length;
      for (const name of names) if (looksLikeCareersHost(name.slice(0, -domain.length - 1))) candidates.set(name, candidates.get(name) ?? "certificate_transparency");
    } catch (error) {
      report.failures.push({ companyDomain: domain, reason: "ct_request_failed", detail: error instanceof Error ? error.message : String(error) });
    }
    report.candidates += candidates.size;
    for (const [host, via] of candidates) {
      if ((await resolve(host)).length === 0) continue;
      report.resolved += 1;
      report.seeds.push({ companyName: seed.companyName, companyDomain: domain, careerUrl: `https://${host}/`, via });
    }
  }
  await atomicJson(outputPath, report.seeds.map(({ companyName, companyDomain, careerUrl }) => ({ companyName, companyDomain, careerUrl })));
  return report;
}

/** Distinct hostnames under `domain` that appear in certificate transparency logs. One request per company. */
export async function certificateNames(domain: string, fetcher: Fetch): Promise<string[]> {
  const response = await fetcher(`https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, { headers: { "user-agent": "openings-discovery/0.1 (+https://avagama.co/openings/)" }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`crt.sh returned HTTP ${response.status}`);
  const rows = await response.json() as Array<{ name_value?: string }>;
  const names = new Set<string>();
  for (const row of rows) for (const raw of String(row.name_value ?? "").split("\n")) {
    const name = raw.trim().toLowerCase().replace(/^\*\./, "");
    if (name.endsWith(`.${domain}`) && /^[a-z0-9.-]+$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

async function readSeeds(path: string): Promise<SubdomainSeed[]> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(value) || !value.every((row) => typeof row === "object" && row !== null && typeof (row as SubdomainSeed).companyName === "string" && typeof (row as SubdomainSeed).companyDomain === "string")) throw new Error("Seed file must be a JSON array of { companyName, companyDomain }");
  return value as SubdomainSeed[];
}
