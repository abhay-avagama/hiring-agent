import type { Ats, RejectedSource, SourceCandidate, SourceRejectionReason, SourceVerificationResult, VerifiedCompany } from "./types.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface VerificationOptions {
  fetch?: Fetch;
  now?: () => Date;
  concurrency?: number;
  timeoutMs?: number;
}

interface ResolvedSource { ats: Ats; token: string; canonicalSourceUrl: string }

export async function verifyCandidates(candidates: SourceCandidate[], options: VerificationOptions = {}): Promise<SourceVerificationResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
  const verified: Array<{ index: number; value: VerifiedCompany }> = [];
  const rejected: Array<{ index: number; value: RejectedSource }> = [];
  const seenSources = new Set<string>();
  const seenCompanies = new Set<string>();
  const seenSlugs = new Set<string>();
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const index = cursor++;
      const candidate = candidates[index];
      if (!candidate) continue;
      const invalid = validateCandidate(candidate);
      if (invalid) { rejected.push({ index, value: rejection(candidate, "invalid_candidate", invalid) }); continue; }
      const source = resolveSource(candidate.sourceUrl);
      if (!source) { rejected.push({ index, value: rejection(candidate, "unsupported_source", "URL is not a supported Greenhouse, Lever, or Ashby job source") }); continue; }
      const sourceKey = `${source.ats}:${source.token.toLocaleLowerCase()}`;
      if (seenSources.has(sourceKey)) { rejected.push({ index, value: rejection(candidate, "duplicate_source", `Duplicate of ${sourceKey}`) }); continue; }
      seenSources.add(sourceKey);
      const companyKey = candidate.companyDomain.toLocaleLowerCase();
      if (seenCompanies.has(companyKey)) { rejected.push({ index, value: rejection(candidate, "duplicate_company", `Duplicate company domain: ${companyKey}`) }); continue; }
      const slug = candidate.slug ?? slugFromDomain(candidate.companyDomain);
      if (seenSlugs.has(slug)) { rejected.push({ index, value: rejection(candidate, "duplicate_slug", `Generated catalog slug is already used: ${slug}`) }); continue; }
      seenCompanies.add(companyKey);
      seenSlugs.add(slug);

      try {
        const evidence = await probe(candidate, source, fetcher, timeoutMs);
        if (!identityMatches(candidate.companyName, candidate.companyDomain, evidence.observedCompanyName, source.token)) {
          rejected.push({ index, value: rejection(candidate, "identity_mismatch", `Expected ${candidate.companyName}; observed ${evidence.observedCompanyName}`) });
          continue;
        }
        verified.push({ index, value: {
          slug, name: candidate.companyName.trim(), ats: source.ats, token: source.token,
          cohorts: normalizeCohorts(candidate.cohorts), companyDomain: companyKey, sourceUrl: source.canonicalSourceUrl,
          discoveredFrom: candidate.discoveredFrom,
          verification: { ...evidence, checkedAt: now().toISOString(), canonicalSourceUrl: source.canonicalSourceUrl },
        } });
      } catch (error) {
        const reason = error instanceof VerificationError ? error.reason : "unreachable";
        rejected.push({ index, value: rejection(candidate, reason, error instanceof Error ? error.message : String(error)) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return {
    verified: verified.sort((a, b) => a.index - b.index).map((row) => row.value),
    rejected: rejected.sort((a, b) => a.index - b.index).map((row) => row.value),
  };
}

async function probe(candidate: SourceCandidate, source: ResolvedSource, fetcher: Fetch, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const endpoint = source.ats === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(source.token)}/jobs?content=true`
    : source.ats === "lever"
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(source.token)}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(source.token)}`;
  try {
    const response = await fetcher(endpoint, { signal: controller.signal });
    if (!response.ok) throw new VerificationError("unreachable", `HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "unknown";
    let body: unknown;
    try { body = await response.json(); } catch { throw new VerificationError("invalid_payload", "Endpoint did not return JSON"); }
    const jobs = source.ats === "greenhouse" ? recordArray(body, "jobs") : source.ats === "lever" ? array(body) : recordArray(body, "jobs");
    if (!jobs) throw new VerificationError("invalid_payload", "Payload does not contain the expected jobs array");
    if (jobs.length === 0) throw new VerificationError("empty_board", "Source has no jobs, so identity cannot be verified");
    const providerName = source.ats === "greenhouse" ? majority(jobs.map((job) => stringField(job, "company_name")).filter(Boolean)) : "";
    const observedCompanyName = providerName || source.token;
    return {
      observedCompanyName,
      identityEvidence: (providerName ? "provider_company_name" : "token_name_match") as "provider_company_name" | "token_name_match",
      contentType,
      jobCount: jobs.length,
    };
  } finally { clearTimeout(timer); }
}

function resolveSource(value: string): ResolvedSource | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const parts = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLocaleLowerCase();
  let ats: Ats | undefined;
  let token: string | undefined;
  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") { ats = "greenhouse"; token = parts[0]; }
  else if (host === "boards-api.greenhouse.io" && parts[0] === "v1" && parts[1] === "boards") { ats = "greenhouse"; token = parts[2]; }
  else if (host === "jobs.lever.co") { ats = "lever"; token = parts[0]; }
  else if (host === "jobs.ashbyhq.com") { ats = "ashby"; token = parts[0]; }
  if (!ats || !token) return null;
  const canonicalSourceUrl = ats === "greenhouse" ? `https://job-boards.greenhouse.io/${token}` : ats === "lever" ? `https://jobs.lever.co/${token}` : `https://jobs.ashbyhq.com/${token}`;
  return { ats, token, canonicalSourceUrl };
}

function validateCandidate(candidate: SourceCandidate): string | null {
  if (!candidate.companyName?.trim()) return "companyName is required";
  if (candidate.slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.slug)) return "slug must contain lowercase letters, numbers, and single hyphens";
  if (!candidate.companyDomain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate.companyDomain)) return "companyDomain must be a hostname";
  if (!candidate.sourceUrl) return "sourceUrl is required";
  if (!candidate.discoveredFrom?.channel || !candidate.discoveredFrom.reference?.trim()) return "discoveredFrom channel and reference are required";
  return null;
}

function identityMatches(expected: string, domain: string, observed: string, token: string): boolean {
  const left = normalizeName(expected);
  const right = normalizeName(observed);
  const normalizedToken = normalizeName(token);
  const domainLabel = normalizeName(domain.replace(/^www\./, "").split(".")[0] ?? "");
  const sourceMatches = left === right || left.includes(right) || right.includes(left) || left.includes(normalizedToken) || normalizedToken.includes(left);
  const domainMatches = left.includes(domainLabel) || domainLabel.includes(left);
  return left.length >= 3 && domainLabel.length >= 3 && sourceMatches && domainMatches;
}

function normalizeName(value: string): string { return value.toLocaleLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|company)\b/g, "").replace(/[^a-z0-9]/g, ""); }
function normalizeCohorts(value?: string[]): string[] | undefined { const result = [...new Set(value?.map((code) => code.toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code)) ?? [])]; return result.length ? result.sort() : undefined; }
function slugFromDomain(domain: string): string { return domain.toLocaleLowerCase().replace(/^www\./, "").split(".")[0]!.replace(/[^a-z0-9-]/g, "-"); }
function rejection(candidate: SourceCandidate, reason: SourceRejectionReason, detail: string): RejectedSource { return { ...candidate, reason, detail }; }
function array(value: unknown): Record<string, unknown>[] | null { return Array.isArray(value) && value.every(isRecord) ? value : null; }
function recordArray(value: unknown, key: string): Record<string, unknown>[] | null { return isRecord(value) ? array(value[key]) : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringField(value: Record<string, unknown>, key: string): string { return typeof value[key] === "string" ? value[key] : ""; }
function majority(values: string[]): string { return values.sort((a, b) => values.filter((v) => v === b).length - values.filter((v) => v === a).length)[0] ?? ""; }

class VerificationError extends Error { constructor(readonly reason: SourceRejectionReason, message: string) { super(message); } }
