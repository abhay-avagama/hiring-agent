import { classifyJob } from "./locations.ts";
import { countryLabel } from "./providers.ts";
import { extractLinks, fetchSafePage, robotsAllows, type PageTransport, type ResolveHost } from "./safe-head.ts";
import type { Job } from "./types.ts";

/**
 * Company-owned career sites: the only thing read is the schema.org JobPosting JSON-LD block that employers publish
 * for search engines. Discovery is bounded (robots.txt honoured, same company domain, a page cap, a delay between
 * requests) and page prose is never interpreted.
 */
export interface SitePosting { title: string; company?: string; location: string; url: string; identifier?: string; datePosted?: string; validThrough?: string; description: string; remote: boolean }
export interface SiteSeed { companyName: string; companyDomain: string; careerUrl?: string }
export interface SiteCrawlOptions { resolveHost?: ResolveHost; pageTransport?: PageTransport; timeoutMs?: number; maxPages?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
export interface SiteCrawlResult { careerUrl?: string; robotsBlocked: boolean; candidatePages: number; pagesFetched: number; postings: SitePosting[]; issues: string[] }

const JOB_PATH = /job|career|opening|vacanc|position|recruit|apply|hiring/i;

export function ownedBy(url: string, companyDomain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const domain = companyDomain.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  } catch { return false; }
}

/** JobPosting objects from every ld+json block on a page, including @graph, arrays, and ItemList wrappers. */
export function extractJobPostings(html: string, pageUrl: string): SitePosting[] {
  const postings: SitePosting[] = [];
  for (const match of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let value: unknown;
    try { value = JSON.parse(match[1]!.trim().replace(/^<!--|-->$/g, "")); } catch { continue; }
    for (const node of walk(value)) {
      const type = node["@type"];
      const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
      if (!types.some((entry) => entry.toLowerCase() === "jobposting")) continue;
      const posting = normalizePosting(node, pageUrl);
      if (posting) postings.push(posting);
    }
  }
  return postings;
}

function* walk(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 6) return;
  if (Array.isArray(value)) { for (const item of value) yield* walk(item, depth + 1); return; }
  if (!isRecord(value)) return;
  yield value;
  for (const key of ["@graph", "itemListElement", "item", "mainEntity", "hasPart"]) if (key in value) yield* walk(value[key], depth + 1);
}

function normalizePosting(node: Record<string, unknown>, pageUrl: string): SitePosting | null {
  const title = text(node.title) || text(node.name);
  if (!title) return null;
  const organization = isRecord(node.hiringOrganization) ? text(node.hiringOrganization.name) : text(node.hiringOrganization);
  const locations = (Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation]).filter(isRecord).map(placeText).filter(Boolean);
  const remote = String(node.jobLocationType ?? "").toUpperCase().includes("TELECOMMUTE");
  const applicant = isRecord(node.applicantLocationRequirements) ? [node.applicantLocationRequirements] : Array.isArray(node.applicantLocationRequirements) ? node.applicantLocationRequirements.filter(isRecord) : [];
  const applicantText = applicant.map((entry) => text(entry.name)).filter(Boolean).join("; ");
  const location = locations.join("; ") || (remote ? `Remote${applicantText ? ` (${applicantText})` : ""}` : "Unspecified");
  const identifier = isRecord(node.identifier) ? text(node.identifier.value) || text(node.identifier.name) : text(node.identifier);
  let url = text(node.url) || (isRecord(node.mainEntityOfPage) ? text(node.mainEntityOfPage["@id"]) : text(node.mainEntityOfPage)) || pageUrl;
  try { url = new URL(url, pageUrl).href; } catch { url = pageUrl; }
  return {
    title, company: organization || undefined, location, url, identifier: identifier || undefined,
    datePosted: isoDate(node.datePosted), validThrough: isoDate(node.validThrough),
    description: stripHtml(text(node.description)).slice(0, 20_000), remote,
  };
}

function placeText(place: Record<string, unknown>): string {
  const address = isRecord(place.address) ? place.address : place;
  const parts = [text(address.addressLocality), text(address.addressRegion), text(address.addressCountry) ? countryLabel(text(address.addressCountry)) : ""].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return text(place.name) || (typeof place.address === "string" ? place.address : "");
}

/** Find the careers page, gather job-like links from it and from sitemaps, and read the JobPosting blocks on each. */
export async function crawlSite(seed: SiteSeed, options: SiteCrawlOptions = {}): Promise<SiteCrawlResult> {
  const maxPages = options.maxPages ?? 25;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetchOptions = { resolveHost: options.resolveHost, transport: options.pageTransport, timeoutMs: options.timeoutMs ?? 15_000 };
  const result: SiteCrawlResult = { robotsBlocked: false, candidatePages: 0, pagesFetched: 0, postings: [], issues: [] };
  let requests = 0;
  const get = async (url: string) => {
    if (requests > 0 && options.delayMs) await sleep(options.delayMs);
    requests += 1;
    if (!(await robotsAllows(url, fetchOptions))) { result.robotsBlocked = true; return null; }
    const page = await fetchSafePage(url, fetchOptions);
    if (page.status !== 200 || !ownedBy(page.finalUrl, seed.companyDomain)) return null;
    return page;
  };
  const candidates = seed.careerUrl ? [seed.careerUrl] : ["careers", "career", "jobs"].map((path) => `https://${seed.companyDomain}/${path}`);
  let landing: { finalUrl: string; html: string } | null = null;
  for (const url of candidates) {
    try { landing = await get(url); if (landing) { result.careerUrl = landing.finalUrl; break; } }
    catch (error) { result.issues.push(`${url}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const seen = new Set<string>();
  const pages: string[] = [];
  const consider = (url: string) => { if (!seen.has(url) && ownedBy(url, seed.companyDomain) && JOB_PATH.test(new URL(url).pathname)) { seen.add(url); pages.push(url); } };
  if (landing) {
    result.postings.push(...extractJobPostings(landing.html, landing.finalUrl));
    result.pagesFetched += 1;
    for (const link of extractLinks(landing.html, landing.finalUrl)) consider(link);
  }
  // Sitemaps list the job-detail pages that carry the markup; read at most three of them.
  const origin = `https://${seed.companyDomain.replace(/^www\./, "")}`;
  const sitemaps = await sitemapUrls(origin, fetchOptions);
  let sitemapReads = 0;
  for (const sitemap of sitemaps) {
    if (sitemapReads >= 3 || pages.length >= maxPages * 4) break;
    try {
      const page = await get(sitemap);
      if (!page) continue;
      sitemapReads += 1;
      for (const loc of page.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        const url = loc[1]!;
        if (/sitemap/i.test(new URL(url).pathname) && JOB_PATH.test(url) && sitemapReads < 3 && !sitemaps.includes(url)) sitemaps.push(url);
        else consider(url);
      }
    } catch (error) { result.issues.push(`${sitemap}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  result.candidatePages = pages.length;
  for (const url of pages.slice(0, maxPages)) {
    try {
      const page = await get(url);
      if (!page) continue;
      result.pagesFetched += 1;
      result.postings.push(...extractJobPostings(page.html, page.finalUrl));
    } catch (error) { result.issues.push(`${url}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const unique = new Map<string, SitePosting>();
  for (const posting of result.postings) unique.set(posting.identifier ? `id:${posting.identifier}` : `url:${posting.url}:${posting.title}`, posting);
  result.postings = [...unique.values()];
  return result;
}

async function sitemapUrls(origin: string, fetchOptions: Parameters<typeof fetchSafePage>[1]): Promise<string[]> {
  const urls = new Set<string>([`${origin}/sitemap.xml`]);
  try {
    const robots = await fetchSafePage(`${origin}/robots.txt`, { ...fetchOptions, maxBytes: 64_000 });
    if (robots.status === 200) for (const match of robots.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)) urls.add(match[1]!);
  } catch { /* no robots: conventional sitemap only */ }
  return [...urls];
}

/** Jobs for the catalog from one company site, in the same shape every ATS adapter produces. */
export function sitePostingsToJobs(company: { slug: string; name: string }, postings: SitePosting[]): Job[] {
  return postings.map((posting) => classifyJob({
    id: `jobposting:${company.slug}:${posting.identifier ?? hash(posting.url + posting.title)}`,
    company: company.name, title: posting.title, location: posting.location, remote: posting.remote, workMode: posting.remote ? "remote" : "unknown",
    eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
    url: posting.url, ...(posting.datePosted ? { updatedAt: posting.datePosted } : {}), description: posting.description,
  }));
}

function hash(value: string): string { let h = 2166136261; for (const ch of value) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : ""; }
function isoDate(value: unknown): string | undefined { const time = Date.parse(text(value)); return Number.isFinite(time) ? new Date(time).toISOString() : undefined; }
function stripHtml(value: string): string { return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
