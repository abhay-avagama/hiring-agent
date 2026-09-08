import type { Ats, RejectedSource, SourceCandidate, SourceRejectionReason, SourceVerificationResult, VerifiedCompany } from "./types.ts";
import { extractLinks, fetchSafeHead, fetchSafePage, robotsAllows, type HeadTransport, type PageTransport, type ResolveHost } from "./safe-head.ts";
import { abortableDelay, fetchSourceJobs, isTransientStatus, retryDelayMs } from "./catalog.ts";
import { isEligibleForCountry } from "./locations.ts";
import { providerSpec, resolveProviderSource } from "./providers.ts";
import { ALL_PROVIDERS } from "./types.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface VerificationOptions {
  fetch?: Fetch;
  now?: () => Date;
  concurrency?: number;
  timeoutMs?: number;
  resolveHost?: ResolveHost;
  headTransport?: HeadTransport;
  pageTransport?: PageTransport;
  requireCountry?: string;
  countryGateTimeoutMs?: number;
  providerConcurrency?: Partial<Record<Ats, number>>;
}

export interface ResolvedSource { ats: Ats; token: string; canonicalSourceUrl: string; structuredEndpoint: string }

export async function verifyCandidates(candidates: SourceCandidate[], options: VerificationOptions = {}): Promise<SourceVerificationResult> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? 10));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000));
  const countryGateTimeoutMs = Math.max(1, Math.trunc(options.countryGateTimeoutMs ?? 120_000));
  const probed: Array<{ index: number; candidate: SourceCandidate; sourceKey: string; value: VerifiedCompany }> = [];
  const rejected: Array<{ index: number; value: RejectedSource }> = [];
  const providerLimits = new Map<Ats, Semaphore>();
  const providerCooldowns = new Map<Ats, ProviderCooldown>();
  for (const ats of ALL_PROVIDERS) {
    const fallback = ats === "workday" ? 2 : concurrency;
    providerLimits.set(ats, new Semaphore(Math.max(1, Math.trunc(options.providerConcurrency?.[ats] ?? fallback))));
    providerCooldowns.set(ats, new ProviderCooldown());
  }
  const scheduled = scheduleCandidates(candidates);
  let cursor = 0;

  async function worker() {
    while (cursor < scheduled.length) {
      const row = scheduled[cursor++];
      const index = row?.index ?? -1;
      const candidate = row?.candidate;
      if (!candidate) continue;
      const invalid = validateCandidate(candidate);
      if (invalid) { rejected.push({ index, value: rejection(candidate, "invalid_candidate", invalid) }); continue; }
      const source = resolveSource(candidate.sourceUrl);
      if (!source) { rejected.push({ index, value: rejection(candidate, "unsupported_source", "URL is not a supported Greenhouse, Lever, Ashby, Workday, or Recruitee job source") }); continue; }
      const sourceKey = `${source.ats}:${source.token.toLocaleLowerCase()}`;
      const companyKey = candidate.companyDomain.toLocaleLowerCase();
      const slug = candidate.slug ?? slugFromDomain(candidate.companyDomain);

      const release = await providerLimits.get(source.ats)!.acquire();
      const providerFetch = providerCooldowns.get(source.ats)!.wrap(fetcher);
      try {
        const evidence = await probe(candidate, source, providerFetch, timeoutMs, options.resolveHost, options.headTransport, options.pageTransport);
        const replayed = evidence.identityEvidence === "company_redirect" || evidence.identityEvidence === "company_page_link";
        if (!replayed && !identityMatches(candidate.companyName, candidate.companyDomain, evidence.observedCompanyName, source.token)) {
          rejected.push({ index, value: rejection(candidate, "identity_mismatch", `Expected ${candidate.companyName}; observed ${evidence.observedCompanyName}`) });
          continue;
        }
        const value: VerifiedCompany = {
          slug, name: candidate.companyName.trim(), ats: source.ats, token: source.token,
          cohorts: normalizeCohorts(candidate.cohorts), companyDomain: companyKey, sourceUrl: source.canonicalSourceUrl,
          discoveredFrom: candidate.discoveredFrom,
          domainEvidence: candidate.domainEvidence,
          verification: { ...evidence, checkedAt: now().toISOString(), canonicalSourceUrl: source.canonicalSourceUrl },
        };
        if (options.requireCountry) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error(`Country gate timed out after ${countryGateTimeoutMs}ms`)), countryGateTimeoutMs);
          try {
            const jobs = await fetchSourceJobs(value, providerFetch, controller.signal);
            if (!jobs.some((job) => isEligibleForCountry(job, options.requireCountry!))) {
              rejected.push({ index, value: rejection(candidate, "no_country_jobs", `Complete source feed has no jobs eligible for ${options.requireCountry}`) });
              continue;
            }
          } finally { clearTimeout(timer); }
        }
        probed.push({ index, candidate, sourceKey, value });
      } catch (error) {
        const reason = error instanceof VerificationError ? error.reason : "unreachable";
        rejected.push({ index, value: rejection(candidate, reason, error instanceof Error ? error.message : String(error)) });
      } finally { release(); }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  const verified: Array<{ index: number; value: VerifiedCompany }> = [];
  const seenSources = new Set<string>();
  const seenCompanies = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const row of probed.sort((a, b) => a.index - b.index)) {
    const companyKey = row.value.companyDomain;
    if (seenSources.has(row.sourceKey)) rejected.push({ index: row.index, value: rejection(row.candidate, "duplicate_source", `Duplicate of ${row.sourceKey}`) });
    else if (seenCompanies.has(companyKey)) rejected.push({ index: row.index, value: rejection(row.candidate, "duplicate_company", `Duplicate company domain: ${companyKey}`) });
    else if (seenSlugs.has(row.value.slug)) rejected.push({ index: row.index, value: rejection(row.candidate, "duplicate_slug", `Generated catalog slug is already used: ${row.value.slug}`) });
    else {
      seenSources.add(row.sourceKey); seenCompanies.add(companyKey); seenSlugs.add(row.value.slug);
      verified.push({ index: row.index, value: row.value });
    }
  }
  return {
    verified: verified.sort((a, b) => a.index - b.index).map((row) => row.value),
    rejected: rejected.sort((a, b) => a.index - b.index).map((row) => row.value),
  };
}

function scheduleCandidates(candidates: SourceCandidate[]): Array<{ index: number; candidate: SourceCandidate }> {
  const groups = new Map<string, Array<{ index: number; candidate: SourceCandidate }>>();
  candidates.forEach((candidate, index) => {
    const provider = typeof candidate.sourceUrl === "string" ? resolveSource(candidate.sourceUrl)?.ats ?? "other" : "other";
    const group = groups.get(provider) ?? [];
    group.push({ index, candidate });
    groups.set(provider, group);
  });
  const scheduled: Array<{ index: number; candidate: SourceCandidate }> = [];
  while ([...groups.values()].some((group) => group.length)) {
    for (const group of groups.values()) { const row = group.shift(); if (row) scheduled.push(row); }
  }
  return scheduled;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

class ProviderCooldown {
  private nextAllowedAt = 0;
  wrap(fetcher: Fetch): Fetch {
    return async (input, init) => {
      await abortableDelay(Math.max(0, this.nextAllowedAt - Date.now()), init?.signal ?? undefined);
      const response = await fetcher(input, init);
      if (response.status === 429) this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + retryDelayMs(response, 0));
      return response;
    };
  }
}

async function probe(candidate: SourceCandidate, source: ResolvedSource, fetcher: Fetch, timeoutMs: number, resolveHost?: ResolveHost, headTransport?: HeadTransport, pageTransport?: PageTransport) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const workday = source.ats === "workday" ? parseWorkdayToken(source.token) : undefined;
  const endpoint = source.structuredEndpoint;
  try {
    const init = source.ats === "workday" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }), signal: controller.signal } : { signal: controller.signal };
    const response = await fetchProbeWithRetry(fetcher, endpoint, init);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new VerificationError("unreachable", `HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "unknown";
    const spec = providerSpec(source.ats);
    let body: unknown;
    try { body = spec?.bodyFormat === "text" ? await response.text() : await response.json(); } catch { throw new VerificationError("invalid_payload", "Endpoint did not return JSON"); }
    const jobs = spec ? spec.jobsFromBody(body) : source.ats === "greenhouse" ? recordArray(body, "jobs") : source.ats === "lever" ? array(body) : source.ats === "workday" ? recordArray(body, "jobPostings") : source.ats === "recruitee" ? recordArray(body, "offers") : recordArray(body, "jobs");
    if (!jobs) throw new VerificationError("invalid_payload", "Payload does not contain the expected jobs array");
    if (jobs.length === 0) throw new VerificationError("empty_board", "Source has no jobs, so identity cannot be verified");
    let providerName = spec ? spec.providerName(jobs, body) : source.ats === "greenhouse" ? majority(jobs.map((job) => stringField(job, "company_name")).filter(Boolean)) : source.ats === "workday" ? workday!.tenant : "";
    let infoWebsite = "";
    if (spec?.companyInfo && !providerName) {
      const info = await spec.companyInfo(source.token, async (url, format = "json") => { const reply = await fetchProbeWithRetry(fetcher, url, { signal: controller.signal }); if (!reply.ok) { await reply.body?.cancel().catch(() => undefined); throw new VerificationError("unreachable", `HTTP ${reply.status}`); } return format === "text" ? reply.text() : reply.json(); }).catch((): { name: string; website?: string } => ({ name: "" }));
      providerName = info.name; infoWebsite = info.website ?? "";
    }
    const tenantMatches = source.ats === "workday" && identityMatches(candidate.companyName, candidate.companyDomain, workday!.tenant, source.token);
    const namedProvider = source.ats === "greenhouse" || tenantMatches || Boolean(spec && providerName);
    const hasDomainLink = !namedProvider && (structuredIdentityLinksDomain(jobs, candidate.companyDomain) || Boolean(infoWebsite) && (infoWebsite === candidate.companyDomain.toLowerCase().replace(/^www\./, "") || infoWebsite.endsWith(`.${candidate.companyDomain.toLowerCase().replace(/^www\./, "")}`)));
    const hasRedirectEvidence = !namedProvider && await verifiedCompanyRedirect(candidate, source, resolveHost, headTransport, timeoutMs);
    const hasPageLink = !namedProvider && !hasDomainLink && !hasRedirectEvidence && await verifiedCompanyPageLink(candidate, source, resolveHost, pageTransport, timeoutMs);
    if (!namedProvider && !hasDomainLink && !hasRedirectEvidence && !hasPageLink) throw new VerificationError("identity_mismatch", `Neither structured identity fields, a verified company redirect, nor a company careers-page link point to ${candidate.companyDomain}`);
    const observedCompanyName = namedProvider && providerName ? providerName : candidate.companyName;
    return {
      observedCompanyName,
      identityEvidence: tenantMatches ? "provider_tenant" as const : (namedProvider && providerName ? "provider_company_name" as const : hasDomainLink ? "structured_domain_link" as const : hasRedirectEvidence ? "company_redirect" as const : "company_page_link" as const),
      contentType,
      payloadVersion: spec ? spec.payloadVersion(body) : source.ats === "greenhouse" ? "greenhouse-job-board:v1" : source.ats === "lever" ? "lever-postings:v0" : source.ats === "workday" ? "workday-cxs:v1" : source.ats === "recruitee" ? "recruitee-careers:v1" : `ashby-job-board:${isRecord(body) && typeof body.apiVersion === "string" ? body.apiVersion : "unknown"}`,
      jobCount: source.ats === "workday" && isRecord(body) && typeof body.total === "number" ? body.total : jobs.length,
    };
  } finally { clearTimeout(timer); }
}

async function fetchProbeWithRetry(fetcher: Fetch, endpoint: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(endpoint, init);
    if (response.ok || !isTransientStatus(response.status) || attempt === 2) return response;
    const delayMs = retryDelayMs(response, attempt);
    await response.body?.cancel().catch(() => undefined);
    await abortableDelay(delayMs, init.signal ?? undefined);
  }
  throw new Error("Verification probe exhausted retries");
}

export function resolveSource(value: string): ResolvedSource | null {
  const tableDriven = resolveProviderSource(value);
  if (tableDriven) return tableDriven;
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
  else if (/^[a-z0-9-]+\.recruitee\.com$/u.test(host)) {
    const validPath = parts.length === 0 || parts.length === 2 && parts[0] === "o" || parts.join("/") === "api/offers";
    if (!validPath) return null;
    ats = "recruitee";
    token = host.slice(0, -".recruitee.com".length);
  }
  else if (/\.myworkdayjobs\.com$/.test(host)) {
    const cxs = parts.length === 5 && parts[0] === "wday" && parts[1] === "cxs" && parts[4] === "jobs";
    const localeAndSite = /^[a-z]{2}-[a-z]{2}$/iu.test(parts[0] ?? "") && Boolean(parts[1]) && !parts[1]?.includes(".");
    const board = localeAndSite && (parts.length === 2 || parts.length === 5 && parts[2] === "job");
    if (!cxs && !board) return null;
    const tenant = cxs ? parts[2] : host.split(".")[0];
    const site = cxs ? parts[3] : parts[1];
    if (tenant && site) { ats = "workday"; token = `${host}/${tenant}/${site}`; }
  }
  if (!ats || !token) return null;
  const canonicalSourceUrl = ats === "greenhouse" ? `https://job-boards.greenhouse.io/${token}` : ats === "lever" ? `https://jobs.lever.co/${token}` : ats === "ashby" ? `https://jobs.ashbyhq.com/${token}` : ats === "recruitee" ? `https://${token}.recruitee.com` : (() => { const value = parseWorkdayToken(token); return `https://${value.host}/en-US/${value.site}`; })();
  const structuredEndpoint = ats === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
    : ats === "lever"
      ? `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
      : ats === "ashby"
        ? `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`
        : ats === "recruitee"
          ? `https://${token}.recruitee.com/api/offers`
          : (() => { const value = parseWorkdayToken(token); return `https://${value.host}/wday/cxs/${encodeURIComponent(value.tenant)}/${encodeURIComponent(value.site)}/jobs`; })();
  return { ats, token, canonicalSourceUrl, structuredEndpoint };
}

function parseWorkdayToken(token: string): { host: string; tenant: string; site: string } {
  const [host, tenant, site] = token.split("/");
  if (!host || !tenant || !site) throw new Error("Invalid Workday token");
  return { host, tenant, site };
}

function validateCandidate(candidate: SourceCandidate): string | null {
  if (typeof candidate.companyName !== "string" || !candidate.companyName.trim()) return "companyName is required and must be a string";
  if (candidate.slug !== undefined && (typeof candidate.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.slug))) return "slug must contain lowercase letters, numbers, and single hyphens";
  if (typeof candidate.companyDomain !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate.companyDomain)) return "companyDomain must be a hostname";
  if (typeof candidate.sourceUrl !== "string" || !candidate.sourceUrl) return "sourceUrl is required";
  const channels = new Set(["search", "career_page", "provider_directory", "community", "dataset", "legacy"]);
  if (!isRecord(candidate.discoveredFrom) || typeof candidate.discoveredFrom.channel !== "string" || !channels.has(candidate.discoveredFrom.channel) || typeof candidate.discoveredFrom.reference !== "string" || !candidate.discoveredFrom.reference.trim()) return "discoveredFrom must contain a supported channel and reference";
  if (candidate.cohorts !== undefined && (!Array.isArray(candidate.cohorts) || !candidate.cohorts.every((code) => typeof code === "string"))) return "cohorts must be an array of country codes";
  if (candidate.domainEvidence !== undefined) {
    if (!isRecord(candidate.domainEvidence) || !["authoritative_dataset", "company_registry", "company_redirect", "company_page_link"].includes(String(candidate.domainEvidence.kind)) || typeof candidate.domainEvidence.reference !== "string" || !candidate.domainEvidence.reference) return "domainEvidence must contain a supported kind and reference";
  }
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
function majority(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
function structuredIdentityLinksDomain(jobs: Record<string, unknown>[], domain: string): boolean {
  const escaped = domain.toLocaleLowerCase().replace(/^www\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^https?://(?:www\\.)?${escaped}(?:/|$)`, "i");
  const fields = ["companyUrl", "companyWebsite", "organizationUrl", "organizationWebsite", "website", "careers_url", "careers_apply_url"];
  return jobs.some((job) => fields.some((field) => typeof job[field] === "string" && pattern.test(job[field])));
}

async function verifiedCompanyRedirect(candidate: SourceCandidate, expected: ResolvedSource, resolveHost?: ResolveHost, headTransport?: HeadTransport, timeoutMs?: number): Promise<boolean> {
  if (candidate.domainEvidence?.kind !== "company_redirect") return false;
  try {
    const host = new URL(candidate.domainEvidence.reference).hostname.toLowerCase().replace(/^www\./, "");
    const domain = candidate.companyDomain.toLowerCase().replace(/^www\./, "");
    if (host !== domain && !host.endsWith(`.${domain}`)) return false;
    const result = await fetchSafeHead(candidate.domainEvidence.reference, { resolveHost, transport: headTransport, timeoutMs });
    const observed = resolveSource(result.finalUrl);
    return result.response.ok && observed?.ats === expected.ats && observed.token.toLowerCase() === expected.token.toLowerCase();
  } catch { return false; }
}


/** Replays company_page_link evidence: the company's own careers page, fetched once within robots rules, still links to the exact board. */
async function verifiedCompanyPageLink(candidate: SourceCandidate, expected: ResolvedSource, resolveHost?: ResolveHost, pageTransport?: PageTransport, timeoutMs?: number): Promise<boolean> {
  if (candidate.domainEvidence?.kind !== "company_page_link") return false;
  try {
    const host = new URL(candidate.domainEvidence.reference).hostname.toLowerCase().replace(/^www\./, "");
    const domain = candidate.companyDomain.toLowerCase().replace(/^www\./, "");
    if (host !== domain && !host.endsWith(`.${domain}`)) return false;
    if (!(await robotsAllows(candidate.domainEvidence.reference, { resolveHost, transport: pageTransport, timeoutMs }))) return false;
    const page = await fetchSafePage(candidate.domainEvidence.reference, { resolveHost, transport: pageTransport, timeoutMs });
    if (page.status !== 200) return false;
    return extractLinks(page.html, page.finalUrl).some((link) => { const observed = resolveSource(link); return observed?.ats === expected.ats && observed.token.toLowerCase() === expected.token.toLowerCase(); });
  } catch { return false; }
}

class VerificationError extends Error { constructor(readonly reason: SourceRejectionReason, message: string) { super(message); } }
