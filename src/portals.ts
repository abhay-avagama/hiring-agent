import { classifyJob } from "./locations.ts";
import { asRecords, isRecord, plainText, str, type JsonGet, type ProviderSpec } from "./providers.ts";
import type { Company, Job } from "./types.ts";

/**
 * Employer portals: large Indian employers whose own careers site loads its listing from a public JSON endpoint
 * that needs no login and that robots.txt does not disallow. Same technique as the ATS adapters, one employer or
 * platform per entry. Only public job fields are read; anything else in a payload is never stored.
 */
type Rec = Record<string, unknown>;
const DAY = 86_400_000;
const job = (company: Company, id: string, fields: { title: string; location: string; url: string; updatedAt?: string; description: string; remote?: boolean }): Job => classifyJob({
  id: `${company.ats}:${company.slug}:${id}`, company: company.name, title: fields.title, location: fields.location || "Unspecified",
  remote: fields.remote === true, workMode: fields.remote ? "remote" : "unknown",
  eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown",
  url: fields.url, ...(fields.updatedAt ? { updatedAt: fields.updatedAt } : {}), description: fields.description,
});
const titleCase = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
const iso = (time: number) => new Date(time).toISOString();

/** "Posted within last 24 hours", "Posted 3 days ago", "Posted 1 month ago", "Posted more than 1 month ago". */
export function accenturePostedAt(label: string, now = Date.now()): string | undefined {
  const text = label.toLowerCase();
  if (/24 hours|today/.test(text)) return iso(now);
  const days = /(\d+)\s*days?/.exec(text); if (days) return iso(now - Number(days[1]) * DAY);
  const weeks = /(\d+)\s*weeks?/.exec(text); if (weeks) return iso(now - Number(weeks[1]) * 7 * DAY);
  if (/more than 1 month/.test(text)) return iso(now - 45 * DAY);
  if (/1 month/.test(text)) return iso(now - 30 * DAY);
  return undefined;
}

/** JobPosting description from an employer's job page, for the full text on demand. */
async function jsonLdDescription(url: string, get: JsonGet): Promise<string> {
  const html = String(await get(url, "text"));
  for (const match of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]!.trim()) as unknown;
      for (const node of Array.isArray(value) ? value : [value]) if (isRecord(node) && String(node["@type"]).toLowerCase() === "jobposting" && typeof node.description === "string") return plainText(node.description);
    } catch { /* not JSON */ }
  }
  return "";
}

const ACCENTURE_SITES: Record<string, string> = { "in-en": "India", "us-en": "United States" };
const ACCENTURE_FIELDS = ["requisitionId", "title", "location", "feedCity", "country", "jobDetailUrl", "postedDateText", "staticExtractiveSummary", "mustHaveSkills", "goodToHaveSkills", "yearsOfExperience", "qualificationShort", "remoteType"];
const accenture: ProviderSpec = {
  ats: "accenture", label: "Accenture careers", hosts: ["accenture.com"], crawlPatterns: [],
  resolve(url) { const site = /^\/(in-en|us-en)\/careers/i.exec(url.pathname)?.[1]?.toLowerCase(); return /(^|\.)accenture\.com$/i.test(url.hostname) && site ? site : null; },
  canonicalUrl: (token) => `https://www.accenture.com/${token}/careers/jobsearch`,
  endpoint: () => "https://www.accenture.com/api/accenture/elastic/findjobs",
  jobsFromBody: (body) => (isRecord(body) ? asRecords(body.data) : null),
  providerName: () => "Accenture",
  payloadVersion: () => "accenture-findjobs:v1",
  /** Newest first, 100 a page; stops once a page is older than 30 days, which keeps the crawl to the roles people act on. */
  async fetchAll(token, get) {
    const records: Rec[] = [];
    for (let start = 0; start < 40_000; start += 100) {
      const form = new FormData();
      for (const [key, value] of Object.entries({ startIndex: String(start), maxResultSize: "100", jobKeyword: "", jobCountry: ACCENTURE_SITES[token] ?? "India", jobLanguage: "en", countrySite: token, sortBy: "1", searchType: "vectorSearch", enableQueryBoost: "true", minScore: "0.6", totalHits: "true", jobFilters: "[]" })) form.append(key, value);
      const page = accenture.jobsFromBody(await get(accenture.endpoint(token), "json", { method: "POST", body: form })) ?? [];
      // Rows carry full descriptions and internal fields (about 25 KB each); keep only the public fields normalize reads.
      records.push(...page.map((row) => Object.fromEntries(ACCENTURE_FIELDS.map((key) => [key, row[key]]))));
      const last = str(page[page.length - 1]?.postedDateText).toLowerCase();
      if (page.length < 100 || /month/.test(last)) break;
    }
    return records;
  },
  normalize(company, record) {
    const places = Array.isArray(record.location) ? record.location.map(str).filter(Boolean) : [];
    const country = str(record.country) || ACCENTURE_SITES[company.token] || "India";
    const location = (places.length ? places : [str(record.feedCity)]).filter(Boolean).map((place) => `${place}, ${country}`).join("; ") || country;
    const skills = [str(record.mustHaveSkills) && `Must have skills: ${str(record.mustHaveSkills)}`, str(record.goodToHaveSkills) && `Good to have skills: ${str(record.goodToHaveSkills)}`].filter(Boolean).join("\n");
    const description = [plainText(str(record.staticExtractiveSummary)), skills, str(record.yearsOfExperience), str(record.qualificationShort) && `Educational qualification: ${str(record.qualificationShort)}`].filter(Boolean).join("\n\n").slice(0, 2_000);
    return job(company, str(record.requisitionId), {
      title: str(record.title), location, url: str(record.jobDetailUrl).replace("{0}", company.token),
      updatedAt: accenturePostedAt(str(record.postedDateText)), description, remote: /remote/i.test(str(record.remoteType)),
    });
  },
  detail: (_company, current, get) => jsonLdDescription(current.url, get),
};

const infosys: ProviderSpec = {
  ats: "infosys", label: "Infosys careers", hosts: ["infosys.com", "infosysapps.com", "infosysbpm.com"], crawlPatterns: [],
  resolve(url) { return /intapgateway\.infosysapps\.com$/i.test(url.hostname) ? url.searchParams.get("sourceId") : null; },
  canonicalUrl: () => "https://career.infosys.com/joblist",
  endpoint: (token) => `https://intapgateway.infosysapps.com/careersci/search/intapjbsrch/getCareerSearchJobs?sourceId=${encodeURIComponent(token)}&searchText=ALL`,
  jobsFromBody: (body) => asRecords(body),
  providerName: (jobs) => str(jobs[0]?.company),
  payloadVersion: () => "infosys-careersearch:v1",
  normalize(company, record) {
    const created = Date.parse(`${str(record.createdOn)}+05:30`); // the gateway returns India time without a zone
    const description = ["rolesResponsibilities", "technicalRequirement", "additionalResponsibility", "preferredSkills", "educationalRequirement"].map((key) => plainText(str(record[key]))).filter(Boolean).join("\n\n").slice(0, 6_000);
    return job(company, str(record.postingId), {
      title: str(record.postingTitle), location: `${titleCase(str(record.location))}, ${str(record.country) || "India"}`,
      url: `https://career.infosys.com/jobdesc?jobReferenceCode=${encodeURIComponent(str(record.referenceCode))}&sourceId=${encodeURIComponent(str(record.sourceId))}`,
      ...(Number.isFinite(created) ? { updatedAt: iso(created) } : {}), description,
    });
  },
};

const capgemini: ProviderSpec = {
  ats: "capgemini", label: "Capgemini careers", hosts: ["capgemini.com"], crawlPatterns: [],
  resolve(url) { const site = /^\/(in-en|us-en)\//i.exec(url.pathname)?.[1]?.toLowerCase(); return /(^|\.)capgemini\.com$/i.test(url.hostname) && site ? site : null; },
  canonicalUrl: (token) => `https://www.capgemini.com/${token}/careers/join-capgemini/job-search/`,
  endpoint: (token) => `https://cg-jobstream-api.azurewebsites.net/api/job-search?page=1&size=1000&country_code=${encodeURIComponent(token)}`,
  jobsFromBody: (body) => (isRecord(body) ? asRecords(body.data) : null),
  providerName: () => "Capgemini",
  payloadVersion: () => "capgemini-jobstream:v1",
  // Capgemini's feed carries a last-updated time, not a posting date; it is the best date the employer publishes.
  normalize(company, record) {
    const ref = str(record.ref); const source = str(record.source).toLowerCase();
    return job(company, str(record.id), {
      title: str(record.title), location: `${str(record.location)}, ${str(record.country_name) || "India"}`,
      url: `https://www.capgemini.com/${company.token}/jobs/${encodeURIComponent(ref)}+${encodeURIComponent(source)}`,
      updatedAt: str(record.updated_at) || undefined, description: plainText(str(record.description_stripped) || str(record.description)).slice(0, 6_000),
    });
  },
};

export const PORTALS: ProviderSpec[] = [accenture, infosys, capgemini];
