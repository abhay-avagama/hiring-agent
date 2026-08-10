import type { Job } from "./types.ts";

const INDIA_PLACES = [
  "india", "bharat",
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat",
  "haryana", "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra",
  "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "punjab", "rajasthan", "sikkim",
  "tamil nadu", "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "andaman", "chandigarh", "dadra", "daman", "delhi", "jammu", "kashmir", "ladakh", "lakshadweep", "puducherry",
  "bengaluru", "bangalore", "hyderabad", "pune", "chennai", "mumbai", "gurugram", "gurgaon", "noida",
  "kolkata", "ahmedabad", "kochi", "cochin", "jaipur", "coimbatore", "indore", "thiruvananthapuram",
  "mysuru", "mysore", "bhubaneswar", "lucknow", "nagpur", "visakhapatnam", "vizag", "vadodara", "surat",
];

const INDIA_PATTERN = new RegExp(`\\b(${INDIA_PLACES.map(escapeRegExp).join("|")})\\b`, "i");
const INDIA_INCLUSIVE_REGION_PATTERN = /\b(apac|asia|asia[ -]pacific|worldwide|anywhere|global)\b/i;
const INDIA_EXCLUSION_PATTERN = /\b(not available|unavailable|excluding|except|cannot hire|can't hire|unable to hire|do not hire|does not hire)\b.{0,80}\b(india|apac|asia)\b|\b(india|apac|asia)\b.{0,40}\b(excluded|not eligible|not supported)\b/i;
const INDIA_ELIGIBILITY_PATTERN = /\b(remote (?:in|from)|available (?:in|to)|open to|hiring (?:in|from)|candidates? (?:in|from)|applicants? (?:in|from)|work (?:in|from)|based in)\b.{0,80}\b(india|apac|asia)\b|\b(india|apac|asia)\b.{0,40}\b(remote|candidates?|applicants?|eligible|hiring)\b/i;

export function normalizeLocation(value: string): string {
  const aliases: Record<string, string> = {
    bangalore: "bengaluru",
    gurgaon: "gurugram",
    bombay: "mumbai",
    calcutta: "kolkata",
    madras: "chennai",
    mysore: "mysuru",
    orissa: "odisha",
  };
  return value.trim().toLocaleLowerCase().replace(/\b(bangalore|gurgaon|bombay|calcutta|madras|mysore|orissa)\b/g, (name) => aliases[name] ?? name);
}

export function isExplicitlyIndiaEligible(job: Job): boolean {
  if (job.remote && INDIA_EXCLUSION_PATTERN.test(`${job.location}\n${job.description}`)) return false;
  if (INDIA_PATTERN.test(job.location)) return true;
  if (!job.remote) return false;
  return INDIA_INCLUSIVE_REGION_PATTERN.test(job.location) || INDIA_ELIGIBILITY_PATTERN.test(job.description);
}

export function classifyJob(job: Job): Job {
  const workMode = inferWorkMode(job.location, job.workMode);
  const evidence = `${job.location}\n${job.description}`;
  const excludedCountries = detectExcludedCountries(evidence);
  const eligibleCountries = detectCountries(job.location);
  if (workMode === "remote") eligibleCountries.push(...detectEligibleCountries(job.description));
  const uniqueEligibleCountries = [...new Set(eligibleCountries)].filter((code) => !excludedCountries.includes(code));
  const eligibleRegions = workMode === "remote" ? detectRegions(job.location, job.description) : [];
  const withMode = { ...job, remote: workMode === "remote", workMode };
  const indiaLocation = INDIA_PATTERN.test(job.location);
  const indiaDescription = workMode === "remote" && INDIA_ELIGIBILITY_PATTERN.test(job.description);
  if ((indiaLocation || indiaDescription) && !excludedCountries.includes("IN") && !uniqueEligibleCountries.includes("IN")) uniqueEligibleCountries.push("IN");
  return {
    ...withMode,
    eligibleCountries: uniqueEligibleCountries.sort(),
    excludedCountries,
    eligibleRegions,
    eligibilityConfidence: uniqueEligibleCountries.length > 0 ? "explicit" : eligibleRegions.length > 0 ? "inferred" : "unknown",
  };
}

export function isEligibleForCountry(job: Job, country: string): boolean {
  const code = country.toUpperCase();
  if (job.excludedCountries.includes(code)) return false;
  if (job.eligibleCountries.includes(code)) return true;
  if (job.eligibleRegions.includes("worldwide")) return true;
  return job.eligibleRegions.some((region) => regionIncludes(region, code));
}

function detectExcludedCountries(value: string): string[] {
  const excluded: string[] = [];
  for (const rule of countryRules()) {
    if (rule.exclusion.test(value)) excluded.push(rule.code);
  }
  return excluded.sort();
}

function inferWorkMode(location: string, supplied: Job["workMode"]): Job["workMode"] {
  if (supplied !== "unknown") return supplied;
  if (/\bremote\b/i.test(location)) return "remote";
  if (/\bhybrid\b/i.test(location)) return "hybrid";
  if (/\b(on[ -]?site|office[ -]?based)\b/i.test(location)) return "onsite";
  return "unknown";
}

function detectRegions(location: string, description: string): string[] {
  const regions: Array<[string, RegExp]> = [
    ["worldwide", /\b(worldwide|anywhere|global)\b/i],
    ["APAC", /\b(APAC|Asia[ -]Pacific)\b/i],
    ["Asia", /\bAsia\b/i],
    ["EMEA", /\bEMEA\b/i],
    ["LATAM", /\b(LATAM|Latin America)\b/i],
  ];
  const fromLocation = regions.filter(([, pattern]) => pattern.test(location)).map(([name]) => name);
  const eligibilityPhrase = /\b(remote|open to|hiring|candidates?|applicants?|eligible|work from)\b.{0,60}\b(worldwide|anywhere|global|APAC|Asia[ -]Pacific|Asia|EMEA|LATAM|Latin America)\b/gi;
  const fromDescription: string[] = [];
  for (const match of description.matchAll(eligibilityPhrase)) {
    const value = match[2] ?? "";
    const region = regions.find(([, pattern]) => pattern.test(value))?.[0];
    if (region) fromDescription.push(region);
  }
  return [...new Set([...fromLocation, ...fromDescription])];
}

function detectCountries(location: string): string[] {
  const matches: string[] = [];
  for (const rule of countryRules()) {
    if (rule.location.test(location)) matches.push(rule.code);
  }
  return matches;
}

function detectEligibleCountries(description: string): string[] {
  const matches: string[] = [];
  for (const rule of countryRules()) {
    if (rule.eligibility.test(description)) matches.push(rule.code);
  }
  return matches;
}

let cachedCountryNames: Array<[string, string]> | undefined;
function countryNames(): Array<[string, string]> {
  if (cachedCountryNames) return cachedCountryNames;
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  const names: Array<[string, string]> = [];
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      const name = display.of(code);
      if (name && name !== code && !name.startsWith("Unknown Region")) names.push([code, name]);
    }
  }
  cachedCountryNames = names;
  return names;
}

let cachedCountryMatchers: Array<[string, string]> | undefined;
function countryMatchers(): Array<[string, string]> {
  if (cachedCountryMatchers) return cachedCountryMatchers;
  const aliases: Record<string, string[]> = { US: ["United States", "USA", "U\\.S\\.A\\."], GB: ["United Kingdom", "UK", "U\\.K\\."], AE: ["United Arab Emirates", "UAE"] };
  cachedCountryMatchers = countryNames().map(([code, name]) => [code, `\\b(?:${[name, ...(aliases[code] ?? [])].map(escapeRegExpUnlessPattern).join("|")})\\b`]);
  return cachedCountryMatchers;
}

interface CountryRule { code: string; location: RegExp; exclusion: RegExp; eligibility: RegExp }
let cachedCountryRules: CountryRule[] | undefined;
function countryRules(): CountryRule[] {
  if (cachedCountryRules) return cachedCountryRules;
  cachedCountryRules = countryMatchers().map(([code, country]) => ({
    code,
    location: new RegExp(country, "i"),
    exclusion: new RegExp(`\\b(not available|unavailable|excluding|except|cannot hire|can't hire|unable to hire|do not hire|does not hire)\\b.{0,80}(?:${country})|(?:${country}).{0,40}\\b(excluded|not eligible|not supported)\\b`, "i"),
    eligibility: new RegExp(`\\b(open to|hiring|candidates?|applicants?|eligible|remote (?:in|from)|work (?:in|from)|based in|available (?:in|to))\\b.{0,80}(?:${country})`, "i"),
  }));
  return cachedCountryRules;
}

function regionIncludes(region: string, code: string): boolean {
  if (region === "worldwide") return true;
  const groups: Record<string, string> = {
    APAC: "AU BN CN FJ HK ID IN JP KH KR LA MM MN MO MY NP NZ PH PK SG TH TW VN",
    Asia: "AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
    EMEA: "AD AE AF AL AM AO AT AZ BA BE BF BG BH BI BJ BW BY CD CF CG CH CI CM CV CY CZ DE DJ DK DZ EE EG ER ES ET FI FR GA GB GE GH GM GN GQ GR GW HR HU IE IL IQ IR IS IT JO KE KG KM KW KZ LB LI LR LS LT LU LV LY MA MC MD ME MG MK ML MR MT MU MW MZ NA NE NG NL NO OM PL PS PT QA RO RS RU RW SA SC SD SE SI SK SL SM SN SO SS ST SY SZ TD TG TJ TM TN TR TZ UA UG UZ VA YE ZA ZM ZW",
    LATAM: "AR BO BR BZ CL CO CR CU DO EC GT GY HN HT MX NI PA PE PR PY SR SV UY VE",
  };
  return (` ${groups[region] ?? ""} `).includes(` ${code} `);
}

function escapeRegExpUnlessPattern(value: string): string {
  return value.includes("\\") ? value : escapeRegExp(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
