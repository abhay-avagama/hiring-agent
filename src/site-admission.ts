import { readFile } from "node:fs/promises";
import { atomicJson } from "./atomic-file.ts";
import type { SiteProbeReport } from "./site-probe.ts";
import type { VerifiedCompany } from "./types.ts";

export interface SiteAdmissionResult { admitted: string[]; skippedKnown: string[]; catalogSize: number }

/**
 * Promote company sites that published JobPosting markup in a probe run into the verified catalog. Identity is
 * structural: the postings were read from pages on the company's own domain, so the evidence kind is `company_site`.
 * A company already covered by an ATS board is skipped so it is never counted twice.
 */
export async function admitSites(reportPath: string, catalogPath: string, options: { minPostings?: number; now?: Date } = {}): Promise<SiteAdmissionResult> {
  const report = JSON.parse(await readFile(reportPath, "utf8")) as SiteProbeReport;
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, Omit<VerifiedCompany, "slug">>;
  const knownDomains = new Set(Object.values(catalog).map((entry) => normalize(entry.companyDomain ?? "")).filter(Boolean));
  const checkedAt = (options.now ?? new Date()).toISOString();
  const result: SiteAdmissionResult = { admitted: [], skippedKnown: [], catalogSize: 0 };
  for (const site of report.sites) {
    if (site.postings < (options.minPostings ?? 1) || !site.careerUrl) continue;
    const domain = normalize(site.companyDomain);
    if (knownDomains.has(domain)) { result.skippedKnown.push(domain); continue; }
    let slug = domain.split(".")[0]!.replace(/[^a-z0-9-]/g, "-");
    if (catalog[slug] && normalize(catalog[slug]!.companyDomain ?? "") !== domain) slug = `${slug}-site`;
    catalog[slug] = {
      name: site.companyName.trim(), ats: "jobposting", token: site.careerUrl, companyDomain: domain, sourceUrl: site.careerUrl,
      ...(site.indiaPostings > 0 ? { cohorts: ["IN"] } : {}),
      discoveredFrom: { channel: "career_page", reference: site.careerUrl },
      verification: { checkedAt, canonicalSourceUrl: site.careerUrl, observedCompanyName: site.companyName.trim(), identityEvidence: "company_site", contentType: "text/html", payloadVersion: "jobposting-jsonld:v1", jobCount: site.postings },
    };
    knownDomains.add(domain);
    result.admitted.push(slug);
  }
  result.catalogSize = Object.keys(catalog).length;
  await atomicJson(catalogPath, catalog);
  return result;
}

function normalize(domain: string): string { return domain.toLowerCase().replace(/^www\./, ""); }
