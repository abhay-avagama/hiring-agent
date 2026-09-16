import { classifyJob, isEligibleForCountry, normalizeLocation } from "../src/locations.ts";
import type { JobSnapshot } from "../src/types.ts";

/** Read-only measurement. Location disagreements and duplicate groups are review signals, not removal rules. */
export function auditSearchCoverage(snapshot: JobSnapshot, country = "IN", asOf = snapshot.updatedAt) {
  if (!/^[A-Z]{2}$/.test(country) || !Number.isFinite(Date.parse(asOf))) throw new Error("Valid country and as-of timestamp required");
  const now = Date.parse(asOf), counts: Record<string, number> = {}, cities: Record<string, number> = {}, roles: Record<string, number> = {};
  const exp = { zeroToTwo: 0, threeToFive: 0, sixToTen: 0, aboveTen: 0, unstated: 0, unread: 0 };
  const missingDescriptionsByProvider: Record<string, number> = {};
  const ages = { within7Days: 0, within30Days: 0, older: 0, undated: 0, futureDated: 0 };
  const examples: Array<{ id: string; location: string; locationCountries: string[] }> = [];
  const duplicateGroups = new Map<string, string[]>(), ids = new Set<string>(), companies = new Set<string>();
  let eligible = 0, missingDescription = 0, missingTitle = 0, suspectLocation = 0, repeatedIds = 0, stalePartitions = 0, unknownPartitionDates = 0;
  const patterns: Array<[string, RegExp]> = [["backend", /\bback[- ]?end\b/i], ["frontend", /\bfront[- ]?end\b/i], ["fullstack", /\bfull[- ]?stack\b/i], ["data", /\b(data|analytics|machine learning)\b/i], ["infrastructure", /\b(devops|sre|infrastructure|cloud)\b/i], ["sales", /\b(sales|account executive|business development)\b/i], ["finance", /\b(finance|accounting|accountant)\b/i]];
  for (const [, partition] of Object.entries(snapshot.partitions).sort(([a], [b]) => a.localeCompare(b))) {
    const fetched = Date.parse(partition.fetchedAt);
    if (!Number.isFinite(fetched)) unknownPartitionDates++;
    else if (now - fetched > 14 * 86400000) stalePartitions++;
    for (const job of [...partition.jobs].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!isEligibleForCountry(job, country)) continue;
      eligible++;
      if (ids.has(job.id)) repeatedIds++;
      ids.add(job.id); companies.add(job.company.trim().toLowerCase());
      const provider = job.id.split(":")[0] || "unknown"; counts[provider] = (counts[provider] ?? 0) + 1;
      if (!job.title?.trim()) missingTitle++;
      if (!job.description?.trim()) { missingDescription++; missingDescriptionsByProvider[provider] = (missingDescriptionsByProvider[provider] ?? 0) + 1; }
      const date = Date.parse(job.updatedAt ?? ""), age = (now - date) / 86400000;
      if (!Number.isFinite(date)) ages.undated++;
      else if (age < 0) ages.futureDated++;
      else { if (age <= 7) ages.within7Days++; if (age <= 30) ages.within30Days++; else ages.older++; }
      if (job.experience === undefined) exp.unread++;
      else if (job.experience === null) exp.unstated++;
      else if (job.experience.min <= 2) exp.zeroToTwo++;
      else if (job.experience.min <= 5) exp.threeToFive++;
      else if (job.experience.min <= 10) exp.sixToTen++;
      else exp.aboveTen++;
      const location = normalizeLocation(job.location);
      const city = ["bengaluru", "hyderabad", "pune", "mumbai", "chennai", "gurugram", "noida", "delhi"].find((name) => new RegExp(`\\b${name}\\b`).test(location)) ?? "other_or_unspecified";
      cities[city] = (cities[city] ?? 0) + 1;
      let named = false;
      for (const [name, pattern] of patterns) if (pattern.test(job.title ?? "")) { roles[name] = (roles[name] ?? 0) + 1; named = true; }
      if (!named) roles.other = (roles.other ?? 0) + 1;
      const key = JSON.stringify([job.company.trim().toLowerCase(), (job.title ?? "").trim().toLowerCase(), location]);
      duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), job.id]);
      const locationOnly = classifyJob({ ...job, description: "", workMode: "unknown" });
      if (locationOnly.eligibleCountries.length && !isEligibleForCountry(locationOnly, country)) {
        suspectLocation++;
        if (examples.length < 10) examples.push({ id: job.id, location: job.location, locationCountries: locationOnly.eligibleCountries });
      }
    }
  }
  const sorted = (value: Record<string, number>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return { schemaVersion: 1, country, asOf, snapshotUpdatedAt: snapshot.updatedAt,
    partitionsExamined: Object.keys(snapshot.partitions).length, stalePartitions, unknownPartitionDates,
    eligibleJobs: eligible, distinctCompanyLabels: companies.size, repeatedIds, missingTitle, missingDescription,
    age: ages, experienceByStatedMinimum: exp, jobsByProvider: sorted(counts), missingDescriptionsByProvider: sorted(missingDescriptionsByProvider), cityBuckets: sorted(cities), overlappingTitleBuckets: sorted(roles),
    possibleDuplicateGroups: [...duplicateGroups.values()].filter((group) => group.length > 1).length,
    locationReview: { count: suspectLocation, examples },
    caveats: ["This measures the supplied snapshot only; country-filtered exports cannot establish which sources are missing.", "Company labels are not independently verified employer identities. Title buckets overlap; city buckets are a coarse India-focused sample.", "Location-only disagreement is not proof of incorrect eligibility: remote and description-based permissions may be valid. Duplicate groups may be separate requisitions.", "Posting age uses updatedAt, which may be a provider update timestamp rather than original publication."],
  };
}

if (import.meta.main) {
  const [path, country = "IN", asOf] = Bun.argv.slice(2);
  if (!path) throw new Error("Usage: bun scripts/audit-search-coverage.ts SNAPSHOT [COUNTRY] [AS_OF]");
  const snapshot = await Bun.file(path).json() as JobSnapshot;
  console.log(JSON.stringify(auditSearchCoverage(snapshot, country.toUpperCase(), asOf), null, 2));
}
