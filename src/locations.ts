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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
