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
      !hasExplicitEvidence(profile, requirement) && !transferable.some((item) => equalSkill(item.requirement, requirement)),
    );
    const roleTargets = intent.roles?.length ? intent.roles : inferredRoleTargets(profile);
    const role = roleAlignment(roleTargets, job.title, Boolean(intent.roles?.length));
    const seniority = seniorityAlignment(profile, intent, job);
    const screeningShortfalls = screeningRequirements.filter((item) => item.status !== "supported").length;
    const score = role.score + supported.length * 2 + transferable.length + skillFocus.length * 3 + seniority.score - gaps.length * 2 - screeningShortfalls * 6;
    const fit = screeningRequirements.some((item) => item.status !== "supported") ? "stretch" : classifyFit(score, gaps.length);
    const reasons = [
      ...(role.reason ? [role.reason] : []),
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
  ranked.sort((left, right) => fitRank(right.fit) - fitRank(left.fit) || right.score - left.score || freshness(right.job) - freshness(left.job) || left.index - right.index);
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

function roleAlignment(targets: string[], title: string, explicit: boolean): { score: number; reason?: string } {
  if (!targets.length) return { score: 0 };
  if (!explicit) {
    const matched = targets.some((target) => tokenOverlap(target, title) >= 0.5);
    return matched
      ? { score: 4, reason: "title aligns with resume role evidence" }
      : { score: 0 };
  }
  let best = targets.some((target) => includesPhrase(target, "backend")) ? -6 : 0;
  let kind: "exact" | "adjacent" | "mismatch" = "mismatch";
  for (const target of targets) {
    const backendTarget = includesPhrase(target, "backend");
    if (!backendTarget) {
      if (tokenOverlap(target, title) >= 0.5 && best < 4) { best = 4; kind = "exact"; }
      continue;
    }
    const conflictingSpecialist = /\b(?:product manager|qa|quality assurance|test|support|site reliability|sre|devops|front(?:end|-end)|data|machine learning|ai|ml)\b/i.test(title);
    const compatibleEngineer = /\b(?:engineer|developer)\b/i.test(title);
    if (!conflictingSpecialist && compatibleEngineer && (includesPhrase(title, target) || tokenOverlap(target, title) === 1 || includesPhrase(title, "backend"))) {
      if (best < 6) { best = 6; kind = "exact"; }
      continue;
    }
    const genericSoftware = /\b(?:software engineer|software developer|application developer|full[- ]stack developer)\b/i.test(title);
    const adjacent = genericSoftware && !conflictingSpecialist;
    if (adjacent && best < 3) { best = 3; kind = "adjacent"; }
  }
  if (kind === "exact") return { score: best, reason: explicit ? "title matches explicit role intent" : "title aligns with resume role evidence" };
  if (kind === "adjacent") return { score: best, reason: explicit ? "title is adjacent to explicit role intent" : "title is adjacent to resume role evidence" };
  return { score: best };
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
  for (const requirement of requirements) {
    const facts = explicitEvidence(profile, requirement);
    if (facts.length) grouped.set(requirement.toLocaleLowerCase(), { requirement, factIds: facts.map((fact) => fact.id) });
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

const materialRequirementTerms = [
  "financial products", "databricks", "data warehouses", "etl pipelines", "high-volume messaging", "streaming platforms", "transaction processing",
  "restful services", "microservices", "redis", "mongodb",
] as const;

function detectedRequirements(job: Job): string[] {
  const positive = /\b(?:required?|must|need(?:ed)?|minimum|proficien(?:t|cy)|experience (?:in|with))\b/i;
  const negative = /\b(?:no|not|without|optional|nice to have|preferred)\b/i;
  const clauses = nonOptionalSectionText(job.description).split(/[.!?\n;]+|\b(?:while|whereas|but)\b/i).flatMap((segment) =>
    positive.test(segment) && negative.test(segment) ? splitMixedRequirementClauses(segment, positive, negative) : [segment],
  );
  const requirementText = [
    clauses.filter((segment) => positive.test(segment) && !negative.test(segment)).join("\n"),
    requiredSectionText(job.description),
  ].join("\n");
  return [...requirementFamilies.keys(), ...materialRequirementTerms]
    .filter((requirement) => [requirement, ...(requirementAliases[requirement] ?? [])]
      .some((term) => includesPhrase(requirementText, term) || hyphenatedPhrase(requirementText, term)))
    .map(displayRequirement);
}

const requirementAliases: Record<string, string[]> = {
  "etl pipelines": ["etl pipeline"],
  "data warehouses": ["data warehouse"],
  "streaming platforms": ["streaming platform"],
  "transaction processing": ["transaction-processing"],
};

function requiredSectionText(value: string): string {
  const lines = structuredJobLines(value);
  let required = false;
  const selected: string[] = [];
  for (const line of lines) {
    const section = sectionHeading(line);
    if (section) {
      required = section === "required";
      continue;
    }
    if (required) selected.push(line);
  }
  return selected.join("\n");
}

function nonOptionalSectionText(value: string): string {
  let optional = false;
  const selected: string[] = [];
  for (const line of structuredJobLines(value)) {
    const section = sectionHeading(line);
    if (section) {
      optional = section === "optional";
      continue;
    }
    if (!optional) selected.push(line);
  }
  return selected.join("\n");
}

function structuredJobLines(value: string): string[] {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|ul|ol|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|\u00a0/gi, " ")
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function sectionHeading(value: string): "required" | "optional" | "other" | undefined {
  const heading = value.replace(/:$/, "").trim();
  if (/^(?:what(?:'|’)s required|required qualifications?|requirements?|qualifications?|your experience includes)$/i.test(heading)) return "required";
  if (/^(?:preferred qualifications?|optional requirements?|nice to have)$/i.test(heading)) return "optional";
  if (/^(?:what you(?:'|’)ll do|responsibilities|we take care of our people|benefits|about .+)$/i.test(heading)) return "other";
  return undefined;
}

function hyphenatedPhrase(value: string, phrase: string): boolean {
  return includesPhrase(value.replace(/-/g, " "), phrase.replace(/-/g, " "));
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

function hasExplicitEvidence(profile: CandidateProfile, requirement: string): boolean {
  return explicitEvidence(profile, requirement).length > 0;
}

function explicitEvidence(profile: CandidateProfile, requirement: string): CandidateProfile["facts"] {
  const structuredSkill = requirementFamilies.has(requirement.toLocaleLowerCase()) || ["databricks", "redis", "mongodb"].includes(requirement.toLocaleLowerCase());
  return profile.facts.filter((fact) => structuredSkill
    ? fact.kind === "skill" && equalSkill(fact.value, requirement)
    : fact.kind !== "certification" && includesPhrase(fact.value, requirement));
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
function fitRank(fit: JobMatch["fit"]): number { return { strong: 3, good: 2, stretch: 1 }[fit]; }
function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function displayRequirement(requirement: string): string {
  const names: Record<string, string> = {
    aws: "AWS", gcp: "GCP", sql: "SQL", dbt: "dbt", "node.js": "Node.js", golang: "Golang", postgresql: "PostgreSQL", javascript: "JavaScript", typescript: "TypeScript",
    "etl pipelines": "ETL pipelines", "restful services": "RESTful services", mongodb: "MongoDB", databricks: "Databricks",
  };
  return names[requirement] ?? `${requirement[0]!.toUpperCase()}${requirement.slice(1)}`;
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
