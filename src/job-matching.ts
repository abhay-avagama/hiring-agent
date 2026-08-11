import { validateCandidateProfileEvidence, type CandidateProfile } from "./candidate-profile.ts";
import { isEligibleForCountry, normalizeLocation } from "./locations.ts";
import type { Job } from "./types.ts";
import { evaluateScreeningRequirements } from "./screening-requirements.ts";

export interface CandidateIntent {
  roles?: string[];
  countries?: string[];
  locations?: string[];
  remote?: boolean;
  seniority?: string[];
  requiredSkills?: string[];
  excludedTerms?: string[];
  excludedCountries?: string[];
  excludedLocations?: string[];
  excludedRoles?: string[];
}

export interface SupportedRequirement {
  requirement: string;
  factIds: string[];
}
export interface TransferableRequirement extends SupportedRequirement { via: "backend_programming" | "frontend_programming" | "data_engineering" | "cloud_infrastructure" }

export interface JobMatch {
  job: Job;
  fit: "strong" | "good" | "stretch";
  reasons: string[];
  supported: SupportedRequirement[];
  transferable: TransferableRequirement[];
  gaps: string[];
}

export interface FilteredJob { jobId: string; reasons: string[] }
export interface JobMatchingResult { matches: JobMatch[]; filteredOut: FilteredJob[]; assumptions: string[] }

export function matchJobs(profile: CandidateProfile, intent: CandidateIntent, jobs: Job[], limit = 20): JobMatchingResult {
  if (!validateCandidateProfileEvidence(profile).valid) throw new Error("invalid_candidate_profile");
  const filteredOut: FilteredJob[] = [];
  const ranked: Array<JobMatch & { score: number; index: number }> = [];
  for (const [index, job] of jobs.entries()) {
    const rejectionReasons = hardFilterReasons(job, intent);
    if (rejectionReasons.length) {
      filteredOut.push({ jobId: job.id, reasons: rejectionReasons });
      continue;
    }
    const jobRequirements = detectedRequirements(job);
    const screeningRequirements = evaluateScreeningRequirements(profile, job);
    const supported = supportedRequirements(profile, jobRequirements);
    const transferable = transferableRequirements(profile, jobRequirements, supported);
    const skillFocus = uniqueTerms(intent.requiredSkills ?? []).filter((skill) => includesPhrase(`${job.title}\n${job.description}`, skill));
    const gapCandidates = [...jobRequirements, ...skillFocus, ...screeningRequirements.filter((item) => item.status !== "supported").map((item) => item.requirement)];
    const gaps = [...new Set(gapCandidates)].filter((requirement) =>
      !hasExplicitSkill(profile, requirement) && !transferable.some((item) => equalSkill(item.requirement, requirement)),
    );
    const roleTargets = intent.roles?.length ? intent.roles : inferredRoleTargets(profile);
    const roleMatch = roleTargets.some((role) => tokenOverlap(role, job.title) >= 0.5);
    const seniority = seniorityAlignment(profile, intent, job);
    const screeningShortfalls = screeningRequirements.filter((item) => item.status !== "supported").length;
    const score = (roleMatch ? 4 : 0) + supported.length * 2 + transferable.length + skillFocus.length * 3 + seniority.score - gaps.length * 2 - screeningShortfalls * 6;
    const fit = screeningRequirements.some((item) => item.status !== "supported") ? "stretch" : classifyFit(score, gaps.length);
    const reasons = [
      ...(roleMatch ? [intent.roles?.length ? "title matches explicit role intent" : "title aligns with resume role evidence"] : []),
      ...(seniority.reason ? [seniority.reason] : []),
      ...supported.map((item) => `${item.requirement} is supported by resume evidence`),
      ...transferable.map((item) => `${item.requirement} has related ${item.via} evidence but is not an explicit resume skill`),
      ...skillFocus.map((skill) => `job matches requested skill focus: ${skill}`),
    ];
    ranked.push({
      job,
      fit,
      reasons: reasons.length ? reasons : ["no direct resume evidence matched; retained as a stretch option"],
      supported,
      transferable,
      gaps,
      score,
      index,
    });
  }
  ranked.sort((left, right) => right.score - left.score || freshness(right.job) - freshness(left.job) || left.index - right.index);
  return {
    matches: ranked.slice(0, Math.max(0, limit)).map(({ score: _score, index: _index, ...match }) => match),
    filteredOut,
    assumptions: [
      ...(intent.countries?.length ? [] : ["No positive target country was requested"]),
      ...(intent.roles?.length ? [] : [inferredRoleTargets(profile).length ? "No explicit role intent was supplied; resume role evidence guided ordering" : "No role intent or resume role evidence was available"]),
      ...(typeof intent.remote === "boolean" ? [] : ["No work-mode preference was requested"]),
    ],
  };
}

function hardFilterReasons(job: Job, intent: CandidateIntent): string[] {
  const reasons: string[] = [];
  if (intent.countries?.length && !intent.countries.some((country) => isEligibleForCountry(job, country))) {
    reasons.push(...intent.countries.map((country) => `country_not_eligible:${country.toUpperCase()}`));
  }
  for (const country of intent.excludedCountries ?? []) if (isEligibleForCountry(job, country)) reasons.push(`country_excluded:${country.toUpperCase()}`);
  if (intent.locations?.length && !intent.locations.some((location) => normalizeLocation(job.location).includes(normalizeLocation(location)))) reasons.push("location_mismatch");
  for (const location of intent.excludedLocations ?? []) if (normalizeLocation(job.location).includes(normalizeLocation(location))) reasons.push(`location_excluded:${location}`);
  for (const role of intent.excludedRoles ?? []) if (includesPhrase(job.title, role) || tokenOverlap(role, job.title) === 1) reasons.push(`role_excluded:${role}`);
  if (intent.remote === true && job.workMode !== "remote") reasons.push("remote_required");
  if (intent.remote === false && (job.workMode === "remote" || job.workMode === "unknown")) reasons.push("non_remote_required");
  const searchable = `${job.title}\n${job.company}\n${job.location}\n${job.description}`;
  for (const term of intent.excludedTerms ?? []) if (includesPhrase(searchable, term)) reasons.push(`excluded_term:${term}`);
  return reasons;
}

function supportedRequirements(profile: CandidateProfile, requirements: string[]): SupportedRequirement[] {
  const grouped = new Map<string, SupportedRequirement>();
  for (const fact of profile.facts.filter((candidate) => candidate.kind === "skill" && requirements.some((requirement) => equalSkill(requirement, candidate.value)))) {
    const key = fact.value.toLocaleLowerCase();
    const existing = grouped.get(key);
    if (existing) existing.factIds.push(fact.id);
    else grouped.set(key, { requirement: fact.value, factIds: [fact.id] });
  }
  return [...grouped.values()];
}

const seniorityTerms = ["manager", "principal", "staff", "lead", "senior", "mid", "junior", "intern"] as const;
function seniorityAlignment(profile: CandidateProfile, intent: CandidateIntent, job: Job): { score: number; reason?: string } {
  const requested = intent.seniority?.map((value) => value.toLocaleLowerCase()) ?? profile.inferences.filter((inference) => inference.kind === "seniority").map((inference) => inference.value);
  if (!requested.length) return { score: 0 };
  const jobSeniority = seniorityTerms.find((term) => includesPhrase(job.title, term));
  if (!jobSeniority) return { score: 0 };
  if (requested.includes(jobSeniority)) return { score: 2, reason: `${intent.seniority?.length ? "seniority matches explicit intent" : "seniority aligns with resume evidence"}: ${jobSeniority}` };
  return { score: -2, reason: `seniority differs from ${intent.seniority?.length ? "explicit intent" : "resume evidence"}: ${jobSeniority}` };
}

const requirementFamilies = new Map<string, TransferableRequirement["via"]>([
  ["java", "backend_programming"], ["go", "backend_programming"], ["golang", "backend_programming"], ["python", "backend_programming"], ["ruby", "backend_programming"], ["node.js", "backend_programming"], ["postgresql", "backend_programming"], ["sql", "backend_programming"],
  ["javascript", "frontend_programming"], ["typescript", "frontend_programming"], ["react", "frontend_programming"], ["vue", "frontend_programming"], ["angular", "frontend_programming"],
  ["spark", "data_engineering"], ["hadoop", "data_engineering"], ["dbt", "data_engineering"], ["airflow", "data_engineering"], ["snowflake", "data_engineering"],
  ["aws", "cloud_infrastructure"], ["azure", "cloud_infrastructure"], ["gcp", "cloud_infrastructure"], ["kubernetes", "cloud_infrastructure"], ["docker", "cloud_infrastructure"], ["terraform", "cloud_infrastructure"],
]);

function detectedRequirements(job: Job): string[] {
  const positive = /\b(?:required?|must|need(?:ed)?|minimum|proficien(?:t|cy)|experience (?:in|with))\b/i;
  const negative = /\b(?:no|not|without|optional|nice to have|preferred)\b/i;
  const clauses = job.description.split(/[.!?\n;]+|\b(?:while|whereas|but)\b/i).flatMap((segment) =>
    positive.test(segment) && negative.test(segment) ? splitMixedRequirementClauses(segment, positive, negative) : [segment],
  );
  const requirementText = clauses.filter((segment) => positive.test(segment) && !negative.test(segment)).join("\n");
  return [...requirementFamilies.keys()].filter((skill) => includesPhrase(requirementText, skill)).map(displaySkill);
}

function splitMixedRequirementClauses(segment: string, positive: RegExp, negative: RegExp): string[] {
  const atoms = segment.split(/,|\band\b/i).map((atom) => atom.trim()).filter(Boolean);
  const polarity = atoms.map((atom) => negative.test(atom) ? "negative" : positive.test(atom) ? "positive" : undefined);
  for (const [index, value] of polarity.entries()) {
    if (value) continue;
    polarity[index] = polarity.slice(index + 1).find(Boolean) ?? polarity.slice(0, index).reverse().find(Boolean);
  }
  const groups: string[] = [];
  for (const [index, atom] of atoms.entries()) {
    if (index > 0 && polarity[index] === polarity[index - 1]) groups[groups.length - 1] += ` ${atom}`;
    else groups.push(atom);
  }
  return groups;
}

function hasExplicitSkill(profile: CandidateProfile, requirement: string): boolean {
  return profile.facts.some((fact) => fact.kind === "skill" && equalSkill(fact.value, requirement));
}

function inferredRoleTargets(profile: CandidateProfile): string[] {
  const roles = profile.facts.filter((fact) => fact.kind === "role").map((fact) => fact.value);
  const families = profile.inferences.filter((inference) => inference.kind === "role_family").map((inference) => `${inference.value} engineer`);
  return [...roles, ...families];
}

function transferableRequirements(profile: CandidateProfile, requirements: string[], supported: SupportedRequirement[]): TransferableRequirement[] {
  const inferences = profile.inferences.filter((inference) => inference.kind === "transferable_skill");
  return requirements.flatMap((requirement) => {
    if (supported.some((item) => equalSkill(item.requirement, requirement))) return [];
    const family = requirementFamilies.get(requirement.toLocaleLowerCase());
    const inference = family && inferences.find((candidate) => candidate.value === family);
    return inference ? [{ requirement, via: inference.value, factIds: inference.derivedFromFactIds }] : [];
  });
}

function equalSkill(left: string, right: string): boolean { return left.toLocaleLowerCase() === right.toLocaleLowerCase(); }
function classifyFit(score: number, gapCount: number): JobMatch["fit"] {
  if (score >= 8 && gapCount === 0) return "strong";
  if (score >= 4) return "good";
  return "stretch";
}
function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function displaySkill(skill: string): string {
  const names: Record<string, string> = { aws: "AWS", gcp: "GCP", sql: "SQL", dbt: "dbt", "node.js": "Node.js", golang: "Golang" };
  return names[skill] ?? `${skill[0]!.toUpperCase()}${skill.slice(1)}`;
}

function includesPhrase(value: string, phrase: string): boolean {
  const normalizedPhrase = phrase.trim().toLocaleLowerCase();
  if (!normalizedPhrase) return false;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9+#])${escaped}(?=$|[^a-z0-9+#])`, "i").test(value);
}

function tokenOverlap(left: string, right: string): number {
  const rawLeftTokens = left.toLocaleLowerCase().match(/[a-z0-9+#.]+/g) ?? [];
  const distinctive = rawLeftTokens.filter((token) => !new Set(["engineer", "engineering", "developer", "development"]).has(token));
  const leftTokens = new Set(distinctive.length ? distinctive : rawLeftTokens);
  const rightTokens = new Set(right.toLocaleLowerCase().match(/[a-z0-9+#.]+/g) ?? []);
  if (!leftTokens.size) return 0;
  return [...leftTokens].filter((token) => rightTokens.has(token)).length / leftTokens.size;
}

function freshness(job: Job): number {
  const timestamp = job.updatedAt ? Date.parse(job.updatedAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}
