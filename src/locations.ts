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
  const eligibleCountries = detectCountries(job.location).filter((code) => !excludedCountries.includes(code));
  const eligibleRegions = workMode === "remote" ? detectRegions(`${job.location}\n${job.description}`) : [];
  const withMode = { ...job, remote: workMode === "remote", workMode };
  const indiaLocation = INDIA_PATTERN.test(job.location);
  const indiaDescription = workMode === "remote" && INDIA_ELIGIBILITY_PATTERN.test(job.description);
  if ((indiaLocation || indiaDescription) && !excludedCountries.includes("IN") && !eligibleCountries.includes("IN")) eligibleCountries.push("IN");
  return {
    ...withMode,
    eligibleCountries: eligibleCountries.sort(),
    excludedCountries,
    eligibleRegions,
    eligibilityConfidence: eligibleCountries.length > 0 ? "explicit" : eligibleRegions.length > 0 ? "inferred" : "unknown",
  };
}

export function isEligibleForCountry(job: Job, country: string): boolean {
  const code = country.toUpperCase();
  if (job.excludedCountries.includes(code)) return false;
  if (job.eligibleCountries.includes(code)) return true;
  if (job.eligibleRegions.includes("worldwide")) return true;
  if (code === "IN" && job.eligibleRegions.some((region) => region === "APAC" || region === "Asia")) return true;
  return false;
}

function detectExcludedCountries(value: string): string[] {
  const excluded: string[] = [];
  for (const [code, name] of countryNames()) {
    const escaped = escapeRegExp(name);
    const pattern = new RegExp(`\\b(not available|unavailable|excluding|except|cannot hire|can't hire|unable to hire|do not hire|does not hire)\\b.{0,80}\\b${escaped}\\b|\\b${escaped}\\b.{0,40}\\b(excluded|not eligible|not supported)\\b`, "i");
    if (pattern.test(value)) excluded.push(code);
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

function detectRegions(value: string): string[] {
  const regions: Array<[string, RegExp]> = [
    ["worldwide", /\b(worldwide|anywhere|global)\b/i],
    ["APAC", /\b(APAC|Asia[ -]Pacific)\b/i],
    ["Asia", /\bAsia\b/i],
    ["EMEA", /\bEMEA\b/i],
    ["LATAM", /\b(LATAM|Latin America)\b/i],
  ];
  return regions.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

function detectCountries(location: string): string[] {
  const matches: string[] = [];
  for (const [code, name] of countryNames()) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(location)) matches.push(code);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
