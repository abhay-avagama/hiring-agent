import type { CandidateIntent } from "./job-matching.ts";

type InvalidInput = (field: string, message: string) => Error;
const arrayFields = ["roles", "countries", "locations", "seniority", "requiredSkills", "excludedTerms", "excludedCountries", "excludedLocations", "excludedRoles"] as const;

export function validateCandidateIntent(value: unknown, invalid: InvalidInput, options: { optional?: boolean } = {}): CandidateIntent {
  if (value === undefined && options.optional) return {};
  if (!isRecord(value)) throw invalid("intent", "Candidate intent must be an object");
  assertKnownKeys(value, [...arrayFields, "remote", "maxAgeDays"], "intent", invalid);
  for (const field of arrayFields) {
    const candidate = value[field];
    if (candidate !== undefined && (!Array.isArray(candidate) || !candidate.every((item) => typeof item === "string" && item.trim().length > 0))) throw invalid(`intent.${field}`, `${field} must be an array of non-empty strings`);
    if (Array.isArray(candidate) && new Set(candidate).size !== candidate.length) throw invalid(`intent.${field}`, `${field} must not contain duplicate values`);
  }
  for (const field of ["countries", "excludedCountries"] as const) {
    const countries = value[field];
    if (Array.isArray(countries) && !countries.every((country) => typeof country === "string" && /^[A-Za-z]{2}$/.test(country))) throw invalid(`intent.${field}`, `${field} must contain two-letter country codes`);
  }
  if (value.remote !== undefined && typeof value.remote !== "boolean") throw invalid("intent.remote", "remote must be a boolean");
  if (value.maxAgeDays !== undefined && (!Number.isInteger(value.maxAgeDays) || (value.maxAgeDays as number) < 1 || (value.maxAgeDays as number) > 365)) throw invalid("intent.maxAgeDays", "maxAgeDays must be an integer between 1 and 365");
  return value as unknown as CandidateIntent;
}

export function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, invalid: InvalidInput): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw invalid(`${field}.${unknown}`, `Unknown field: ${field}.${unknown}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
