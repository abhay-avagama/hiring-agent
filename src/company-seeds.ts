import { atomicJson } from "./atomic-file.ts";
import { withFileLock } from "./file-lock.ts";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
interface Options { country: string; fetch?: Fetch }
interface CompanySeed { companyName: string; companyDomain: string }

export interface CompanySeedReport {
  country: string;
  matched: number;
  written: number;
  skipped: number;
  outputPath: string;
}

export async function generateYcCompanySeeds(outputPath: string, options: Options): Promise<CompanySeedReport> {
  const country = options.country.toUpperCase();
  const countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
  if (!/^[A-Z]{2}$/.test(country) || !countryName || countryName === country) throw new Error("country must be a valid two-letter code");
  const response = await (options.fetch ?? globalThis.fetch)("https://yc-oss.github.io/api/companies/all.json");
  if (!response.ok) throw new Error(`YC company API returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("YC company API returned an invalid payload");
  const pattern = new RegExp(`\\b${escapeRegExp(countryName)}\\b`, "i");
  const matched = value.filter((company) => typeof company.all_locations === "string" && pattern.test(company.all_locations));
  const seen = new Set<string>();
  const seeds: CompanySeed[] = [];
  for (const company of matched) {
    if (typeof company.name !== "string" || !company.name.trim() || typeof company.website !== "string") continue;
    let url: URL;
    try { url = new URL(company.website); } catch { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const companyDomain = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(companyDomain) || seen.has(companyDomain)) continue;
    seen.add(companyDomain);
    seeds.push({ companyName: company.name.trim(), companyDomain });
  }
  await withFileLock(outputPath, () => atomicJson(outputPath, seeds));
  return { country, matched: matched.length, written: seeds.length, skipped: matched.length - seeds.length, outputPath };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
