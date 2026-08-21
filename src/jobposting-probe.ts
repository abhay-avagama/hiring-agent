import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { atomicJson } from "./atomic-file.ts";
import { fetchSafeGet, SafeGetError } from "./safe-get.ts";
import { stampReport, type ReportMeta } from "./report-meta.ts";

export interface ProbePage { status: number; finalUrl: string; contentType: string; body: string; requestCount?: number }
interface ProbeOptions { fetchPage?: (url: string, maxRequests: number, companyDomain: string) => Promise<ProbePage>; companyLimit?: number; now?: Date; delayMs?: number; sleep?: (ms: number) => Promise<void>; reportRoot?: string }
interface CompanyResult { companyName: string; companyDomain: string; originHost: string; inputReference: string; status: "qualified" | "unresolved" | "failed"; acceptedJobs: number; attemptedDetailPages: number; discoveredPostings: number; admissionFailures: number; requestAttempts: number; failedRequests: number; jobs: AcceptedJob[]; issues: string[] }
interface AcceptedJob { key: string; signature: string; identifier: boolean; explicitCountry: boolean }
export interface JobPostingProbeReport extends ReportMeta { sample: Array<{ companyName: string; companyDomain: string; inputReference: string }>; companiesChecked: number; acceptedJobs: number; jobsWithIdentifier: number; identifierPresencePercent: number; jobsWithExplicitCountry: number; explicitCountryPercent: number; requests: number; stopped: boolean; stopReason?: string; viability: "pending_second_phase" | "passed" | "failed"; companies: Array<Omit<CompanyResult, "jobs" | "originHost">> }

export async function probeJobPostingJsonLd(inputPath: string, catalogPath: string, reportPath: string, options: ProbeOptions = {}): Promise<JobPostingProbeReport> {
  await assertReportPath(reportPath, options.reportRoot ?? ".openings");
  const fetchPage = options.fetchPage ?? ((url, maxRequests, domain) => fetchSafeGet(url, { maxRequests, allowedDomain: domain, allowedOrigin: new URL(url).hostname }));
  const [markdown, catalogText] = await Promise.all([readFile(inputPath, "utf8"), readFile(catalogPath, "utf8")]);
  const catalog = JSON.parse(catalogText) as Record<string, { companyDomain?: string }>;
  const known = [...new Set(Object.values(catalog).map((company) => normalizeDomain(company.companyDomain ?? "")).filter(Boolean))];
  const seeds = parseSeeds(markdown).filter((seed) => !known.some((domain) => seed.companyDomain === domain || seed.companyDomain.endsWith(`.${domain}`))).slice(0, Math.min(20, options.companyLimit ?? 20));
  let requests = 0;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let requestGate = Promise.resolve();
  let fatalReason: string | undefined;
  const get = async (url: string, domain: string) => {
    let release!: () => void; const previous = requestGate; requestGate = new Promise<void>((resolve) => { release = resolve; }); await previous;
    try {
      if (fatalReason) throw new SafetyViolation(fatalReason);
      const remaining = 320 - requests; if (remaining <= 0) { fatalReason = "global_request_cap"; throw new SafetyViolation(fatalReason); }
      if (requests && delayMs) await sleep(delayMs);
      try { const page = await fetchPage(url, remaining, domain); requests += page.requestCount ?? 1; if (requests > 320) { fatalReason = "global_request_cap"; throw new SafetyViolation(fatalReason); } return page; }
      catch (error) { if (error instanceof SafeGetError) { requests += error.requestCount; if (error.safety) fatalReason = error.message; } else if (!(error instanceof SafetyViolation)) requests += 1; throw error; }
    } finally { release(); }
  };
  const processCompany = async (seed: ReturnType<typeof parseSeeds>[number]): Promise<CompanyResult> => {
    const issues: string[] = [];
    let attemptedDetailPages = 0;
    let discoveredPostings = 0;
    let admissionFailures = 0;
    let requestAttempts = 0;
    let failedRequests = 0;
    const jobs = new Map<string, AcceptedJob>();
    const conflicts = new Set<string>();
    try {
      const companyGet = async (url: string) => { try { const page = await get(url, seed.companyDomain); requestAttempts += page.requestCount ?? 1; if (page.status === 429 || page.status >= 500) { failedRequests += 1; throw new Error(`transport_http_${page.status}`); } return page; } catch (error) { if (error instanceof SafeGetError) { requestAttempts += error.requestCount; failedRequests += error.failedRequestCount; if (error.safety) throw new SafetyViolation(error.message); } throw error; } };
      const policies = new Map<string, ReturnType<typeof parseRobots>>();
      const policyFor = async (host: string) => { const normalized = normalizeDomain(host); const existing = policies.get(normalized); if (existing) return existing; const robots = await companyGet(`https://${normalized}/robots.txt`); const policy = robotsPolicy(robots); policies.set(normalized, policy); return policy; };
      const rules = await policyFor(seed.originHost);
      const sitemapUrls = rules.sitemaps.length ? rules.sitemaps : [`https://${seed.originHost}/sitemap.xml`];
      const detailUrls: string[] = [];
      const sitemapQueue = sitemapUrls.map((url) => ({ url, depth: 0 }));
      const seenSitemaps = new Set<string>();
      while (sitemapQueue.length && seenSitemaps.size < 5) {
        const item = sitemapQueue.shift()!;
        const sitemapUrl = item.url;
        if (seenSitemaps.has(sitemapUrl)) continue;
        if (!allowedUrl(sitemapUrl, seed.companyDomain)) continue;
        const sitemapParsed = new URL(sitemapUrl); const sitemapRules = await policyFor(sitemapParsed.hostname);
        if (!robotsAllows(sitemapParsed, sitemapRules)) continue;
        seenSitemaps.add(sitemapUrl);
        const sitemap = await companyGet(sitemapUrl);
        if (sitemap.status !== 200 || !xmlMediaTypes.has(mediaType(sitemap.contentType))) continue;
        if (/<!DOCTYPE|<!ENTITY/i.test(sitemap.body)) { fatalReason = "unsafe_xml"; throw new SafetyViolation(fatalReason); }
        for (const url of sitemapLocations(sitemap.body)) {
          if (!allowedUrl(url, seed.companyDomain)) continue;
          const parsed = new URL(url); const urlRules = await policyFor(parsed.hostname); if (!robotsAllows(parsed, urlRules)) continue;
          if (item.depth < 1 && /\.xml(?:$|\?)/i.test(url)) sitemapQueue.push({ url, depth: item.depth + 1 });
          else detailUrls.push(url);
        }
      }
      for (const url of [...new Set(detailUrls)].slice(0, 10)) {
        attemptedDetailPages += 1; const page = await companyGet(url);
        if (page.status !== 200 || mediaType(page.contentType) !== "text/html") continue;
        const postings = extractJobPostings(page.body);
        discoveredPostings += postings.length;
        if (postings.length > 1) { fatalReason = "multiple_jobpostings"; throw new SafetyViolation(fatalReason); }
        for (const job of postings) {
          const result = validateJob(job, seed.companyDomain, url, options.now ?? new Date());
          if (!result.accepted) { issues.push(result.reason); admissionFailures += 1; continue; }
          const previous = jobs.get(result.job.key);
          if (previous && previous.signature !== result.job.signature) { conflicts.add(result.job.key); jobs.delete(result.job.key); issues.push("identity_conflict"); }
          else if (!conflicts.has(result.job.key)) jobs.set(result.job.key, result.job);
        }
      }
      return { ...seed, status: jobs.size ? "qualified" : "unresolved", acceptedJobs: jobs.size, attemptedDetailPages, discoveredPostings, admissionFailures, requestAttempts, failedRequests, jobs: [...jobs.values()], issues: [...new Set(issues)] };
    } catch (error) {
      if (error instanceof SafetyViolation) throw error;
      if (!failedRequests) failedRequests = 1;
      return { ...seed, status: "failed", acceptedJobs: 0, attemptedDetailPages, discoveredPostings, admissionFailures, requestAttempts, failedRequests, jobs: [], issues: [error instanceof Error ? error.message : String(error)] };
    }
  };
  const companies: CompanyResult[] = [];
  let stopReason: string | undefined;
  try {
    companies.push(...await runPhase(seeds.slice(0, 10), processCompany));
    const firstGate = healthStop(companies);
    if (firstGate) stopReason = firstGate;
    else if (seeds.length > 10) companies.push(...await runPhase(seeds.slice(10, 20), processCompany));
  } catch (error) { stopReason = error instanceof Error ? error.message : String(error); fatalReason = stopReason; }
  const jobs = companies.flatMap((company) => company.jobs);
  const acceptedJobs = jobs.length;
  const jobsWithIdentifier = jobs.filter((job) => job.identifier).length;
  const jobsWithExplicitCountry = jobs.filter((job) => job.explicitCountry).length;
  const viability: JobPostingProbeReport["viability"] = stopReason ? "failed" : seeds.length < 20 || companies.length < 20 ? "pending_second_phase" : companies.filter((company) => company.status === "qualified").length >= 5 && acceptedJobs >= 20 && percent(jobsWithIdentifier, acceptedJobs) >= 80 && percent(jobsWithExplicitCountry, acceptedJobs) >= 95 ? "passed" : "failed";
  const publicCompanies = companies.map(({ jobs: _jobs, originHost: _originHost, ...company }) => company);
  const sample = seeds.map(({ companyName, companyDomain, inputReference }) => ({ companyName, companyDomain, inputReference }));
  const report = stampReport("jobposting-jsonld-probe:1", 1, { sample, companiesChecked: companies.length, acceptedJobs, jobsWithIdentifier, identifierPresencePercent: percent(jobsWithIdentifier, acceptedJobs), jobsWithExplicitCountry, explicitCountryPercent: percent(jobsWithExplicitCountry, acceptedJobs), requests, stopped: Boolean(stopReason), ...(stopReason ? { stopReason } : {}), viability, companies: publicCompanies }, options.now);
  await atomicJson(reportPath, report);
  return report;
}

function parseSeeds(markdown: string) {
  const rows: Array<{ companyName: string; companyDomain: string; originHost: string; inputReference: string }> = [];
  const pattern = /<li>\s*<a\s+href="(https:\/\/[^"#]+)[^"]*"[^>]*>([^<]+)<\/a>/gi;
  for (const match of markdown.matchAll(pattern)) { const url = new URL(match[1]!); const domain = normalizeDomain(url.hostname); if (!thirdParty(domain)) rows.push({ companyName: decode(match[2]!).trim(), companyDomain: domain, originHost: url.hostname.toLowerCase(), inputReference: match[1]! }); }
  return [...new Map(rows.map((row) => [row.companyDomain, row])).values()];
}
interface RobotsRule { allow: boolean; pattern: string }
function robotsPolicy(page: ProbePage) { if (page.status === 401 || page.status === 403) return { sitemaps: [], rules: [{ allow: false, pattern: "/" }] }; if (page.status === 404 || page.status === 410) return { sitemaps: [], rules: [] as RobotsRule[] }; if (page.status < 200 || page.status >= 300) throw new Error(`robots_unavailable_${page.status}`); return parseRobots(page.body); }
function parseRobots(body: string) {
  const sitemaps: string[] = []; const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = []; let group: { agents: string[]; rules: RobotsRule[] } | undefined; let sawRule = false;
  for (const raw of body.split(/\r?\n/)) { const line = raw.replace(/#.*/, "").trim(); if (!line) continue; const split = line.indexOf(":"); if (split < 0) continue; const key = line.slice(0, split).trim().toLowerCase(); const value = line.slice(split + 1).trim();
    if (key === "sitemap" && value) { sitemaps.push(value); continue; }
    if (key === "user-agent") { if (!group || sawRule) { group = { agents: [], rules: [] }; groups.push(group); sawRule = false; } group.agents.push(value.toLowerCase()); continue; }
    if ((key === "allow" || key === "disallow") && group) { sawRule = true; if (value) group.rules.push({ allow: key === "allow", pattern: value }); }
  }
  const exact = groups.filter((item) => item.agents.some((agent) => "openings".startsWith(agent) && agent !== "*")); const selected = exact.length ? exact : groups.filter((item) => item.agents.includes("*"));
  return { sitemaps, rules: selected.flatMap((item) => item.rules) };
}
function robotsAllows(url: URL, policy: ReturnType<typeof parseRobots>) { const target = `${url.pathname}${url.search}`; const matches = policy.rules.flatMap((rule) => { const source = `^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`; return new RegExp(source).test(target) ? [{ ...rule, length: rule.pattern.replace(/[*$]/g, "").length }] : []; }); matches.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow)); return matches[0]?.allow ?? true; }
function sitemapLocations(xml: string) { return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => decode(match[1]!)); }
function allowedUrl(value: string, domain: string) { try { const url = new URL(value); const host = normalizeDomain(url.hostname); return url.protocol === "https:" && (!url.port || url.port === "443") && (host === domain || host.endsWith(`.${domain}`)); } catch { return false; } }
function extractJobPostings(html: string): Record<string, unknown>[] { const results: Record<string, unknown>[] = []; for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { const value: unknown = JSON.parse(match[1]!.trim()); visit(value, results); } catch { /* malformed JSON-LD is inert */ } } return results; }
function visit(value: unknown, output: Record<string, unknown>[]) { if (Array.isArray(value)) { value.forEach((item) => visit(item, output)); return; } if (!record(value)) return; const type = value["@type"]; if (type === "JobPosting" || Array.isArray(type) && type.includes("JobPosting")) output.push(value); const graph = value["@graph"]; if (graph) visit(graph, output); }
function validateJob(job: Record<string, unknown>, domain: string, pageUrl: string, now: Date): { accepted: false; reason: string } | { accepted: true; reason: ""; job: AcceptedJob } { const org = record(job.hiringOrganization) ? job.hiringOrganization : undefined; if (org?.sameAs !== undefined && !organizationDomainsMatch(org.sameAs, domain)) return fail("organization_domain_conflict"); if (!text(job.title) || !text(job.description) || !validDate(job.datePosted) || !text(org?.name)) return fail("missing_required_field"); if (job.validThrough !== undefined && (!validDate(job.validThrough) || Date.parse(String(job.validThrough)) < now.getTime())) return fail("expired_or_invalid"); const physicalCountry = hasPhysicalCountry(job.jobLocation); const remote = job.jobLocationType === "TELECOMMUTE"; const explicitCountry = physicalCountry || remote && hasApplicantCountry(job.applicantLocationRequirements); if (!explicitCountry) return fail("missing_country"); const identifierValue = record(job.identifier) && text(job.identifier.value) ? job.identifier.value.trim() : undefined; const url = typeof job.url === "string" ? job.url : pageUrl; if (!identifierValue && !allowedUrl(url, domain)) return fail("missing_identity"); const key = identifierValue ? `${domain}:id:${identifierValue}` : `${domain}:url:${normalizeJobUrl(url)}`; const signature = stableStringify(job); return { accepted: true, reason: "", job: { key, signature, identifier: Boolean(identifierValue), explicitCountry } }; }
function organizationDomainsMatch(value: unknown, domain: string): boolean { const values = Array.isArray(value) ? value : [value]; return values.length > 0 && values.every((item) => typeof item === "string" && allowedUrl(item, domain)); }
function hasPhysicalCountry(value: unknown): boolean { if (Array.isArray(value)) return value.some(hasPhysicalCountry); return record(value) && record(value.address) && validCountry(value.address.addressCountry); }
function hasApplicantCountry(value: unknown): boolean { if (Array.isArray(value)) return value.some(hasApplicantCountry); if (!record(value)) return false; const country = record(value.address) ? value.address.addressCountry : value.name; return validCountry(country); }
function fail(reason: string): { accepted: false; reason: string } { return { accepted: false, reason }; }
function thirdParty(domain: string) { return ["linkedin.com", "indeed.com", "github.com", "twitter.com", "angel.co", "wellfound.com", "lever.co", "ashbyhq.com", "greenhouse.io", "myworkdayjobs.com", "recruitee.com"].some((value) => domain === value || domain.endsWith(`.${value}`)); }
function normalizeDomain(value: string) { return value.trim().toLowerCase().replace(/^www\./, ""); }
function normalizeJobUrl(value: string) { const url = new URL(value); url.hash = ""; if (url.port === "443") url.port = ""; return url.href; }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function decode(value: string) { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function validDate(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function text(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function percent(value: number, total: number) { return total ? Math.round(value / total * 10_000) / 100 : 0; }
async function runPhase<T, R>(values: T[], operation: (value: T) => Promise<R>): Promise<R[]> { const output = new Array<R>(values.length); let cursor = 0; let failure: unknown; async function worker() { while (cursor < values.length && !failure) { const index = cursor++; try { output[index] = await operation(values[index]!); } catch (error) { failure = error; } } } await Promise.all(Array.from({ length: Math.min(3, values.length) }, worker)); if (failure) throw failure; return output; }
function healthStop(companies: CompanyResult[]): string | undefined { if (companies.filter((company) => company.status === "qualified").length < 2) return "phase_one_low_yield"; const attempts = companies.reduce((sum, company) => sum + company.requestAttempts, 0); const failed = companies.reduce((sum, company) => sum + company.failedRequests, 0); if (attempts && failed / attempts > 0.1) return "phase_one_transport_failures"; const discovered = companies.reduce((sum, company) => sum + company.discoveredPostings, 0); const admissionFailures = companies.reduce((sum, company) => sum + company.admissionFailures, 0); if (discovered && admissionFailures / discovered > 0.5) return "phase_one_schema_failures"; return undefined; }
class SafetyViolation extends Error {}
const countryNames = new Set(["india", "united states", "usa", "united kingdom", "canada", "germany", "france", "australia", "singapore", "japan", "netherlands", "ireland", "spain", "italy", "brazil", "mexico"]);
function validCountry(value: unknown): boolean { return typeof value === "string" && (/^[A-Z]{2}$/i.test(value.trim()) || countryNames.has(value.trim().toLowerCase())); }
function mediaType(value: string) { return value.split(";", 1)[0]!.trim().toLowerCase(); }
const xmlMediaTypes = new Set(["application/xml", "text/xml", "application/sitemap+xml"]);
async function assertReportPath(path: string, root: string) {
  const expectedRoot = resolve(root);
  const target = resolve(path);
  const lexicalRelation = relative(expectedRoot, target);
  if (!lexicalRelation || lexicalRelation.startsWith("..")) throw new Error("JobPosting probe report must be a file under .openings");
  await mkdir(expectedRoot, { recursive: true });
  if ((await lstat(expectedRoot)).isSymbolicLink()) throw new Error("JobPosting probe report must be a file under .openings");
  await mkdir(dirname(target), { recursive: true });
  const [actualRoot, actualParent] = await Promise.all([realpath(expectedRoot), realpath(dirname(target))]);
  const relation = relative(actualRoot, actualParent);
  if (relation.startsWith("..") || resolve(actualRoot, relation) !== actualParent) throw new Error("JobPosting probe report must be a file under .openings");
}
