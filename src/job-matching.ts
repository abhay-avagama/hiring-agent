import { validateCandidateProfileEvidence, type CandidateProfile } from "./candidate-profile.ts";
import { isEligibleForCountry, normalizeLocation } from "./locations.ts";
import { detectRequirementTerms, findTransferability, matchesExactSkillEvidence, requiresExactSkillEvidence, type TransferabilityKind } from "./requirement-vocabulary.ts";
import type { Job, JobAge } from "./types.ts";
import { DEFAULT_MAX_AGE_DAYS, jobAge, postedTime, withinWindow } from "./catalog.ts";
import { evaluateScreeningRequirements, type ScreeningRequirement } from "./screening-requirements.ts";

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
  /** Only roles posted within this many days. Default 30 keeps undated roles; an explicit value drops them too; 0 includes everything. */
  maxAgeDays?: number;
}

export interface SupportedRequirement {
  requirement: string;
  factIds: string[];
}
export interface TransferableRequirement extends SupportedRequirement { via: TransferabilityKind }
export type RoleFamily = "backend" | "frontend" | "data" | "infrastructure";
export interface RoleFamilyExpansion {
  family: RoleFamily;
  aliases: string[];
  derivedFrom: "explicit_intent" | "resume_evidence";
  evidenceFactIds: string[];
}
export interface TitleExpansion {
  family: RoleFamily;
  alias: string;
  derivedFrom: RoleFamilyExpansion["derivedFrom"];
  evidenceFactIds: string[];
}

export interface JobMatch {
  job: Job;
  fit: "strong" | "good" | "stretch";
  scores: { evidence: number; keyword: number };
  selectedScore: number;
  reasons: string[];
  supported: SupportedRequirement[];
  transferable: TransferableRequirement[];
  gaps: string[];
  discovery: { category: "direct" | "hidden" | "stretch"; titleExpansions: TitleExpansion[] };
  /** The employer's own posting, repeated at the top level so it is never dropped from a summary. */
  applyUrl: string;
  postedDaysAgo?: number;
  age: JobAge;
}

export interface FilteredJob { jobId: string; reasons: string[] }
export interface JobMatchingResult {
  matches: JobMatch[];
  filteredOut: FilteredJob[];
  assumptions: string[];
  exploration: { roleFamilies: RoleFamilyExpansion[]; directMatches: JobMatch[]; hiddenMatches: JobMatch[]; stretchMatches: JobMatch[] };
}
export interface MatchingOptions { mode?: "evidence" | "keyword"; minimumPercent?: number }

export function matchJobs(profile: CandidateProfile, intent: CandidateIntent, jobs: Job[], limit = 20, options: MatchingOptions = {}): JobMatchingResult {
  if (!validateCandidateProfileEvidence(profile).valid) throw new Error("invalid_candidate_profile");
  const mode = options.mode ?? "evidence";
  const roleFamilies = deriveRoleFamilies(profile, intent);
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
    const titleExpansions = matchTitleExpansions(roleFamilies, job);
    const role = roleAlignment(roleTargets, job.title, Boolean(intent.roles?.length), titleExpansions[0]);
    const seniority = seniorityAlignment(profile, intent, job);
    const screeningShortfalls = screeningRequirements.filter((item) => item.status !== "supported").length;
    const score = role.score + supported.length * 2 + transferable.length + skillFocus.length * 3 + seniority.score - gaps.length * 2 - screeningShortfalls * 6;
    const fit = screeningRequirements.some((item) => item.status !== "supported") ? "stretch" : classifyFit(score, gaps.length);
    const scores = {
      evidence: evidencePercent(role, roleTargets, seniority, supported, transferable, gaps, screeningRequirements),
      keyword: keywordPercent(profile, job, screeningRequirements),
    };
    const selectedScore = scores[mode];
    if (options.minimumPercent !== undefined && selectedScore < options.minimumPercent) {
      filteredOut.push({ jobId: job.id, reasons: [`below_minimum_${mode}_score:${selectedScore}`] });
      continue;
    }
    const reasons = [
      ...(role.reason ? [role.reason] : []),
      ...(seniority.reason ? [seniority.reason] : []),
      ...supported.map((item) => `${item.requirement} is supported by resume evidence`),
      ...transferable.map((item) => `${item.requirement} has related ${item.via} evidence but is not an explicit resume skill`),
      ...skillFocus.map((skill) => `job matches requested skill focus: ${skill}`),
    ];
    const category = fit === "stretch" ? "stretch" : directTitleMatch(roleTargets, job.title) ? "direct" : titleExpansions.length ? "hidden" : "stretch";
    ranked.push({
      job,
      fit,
      scores,
      selectedScore,
      reasons: reasons.length ? reasons : ["no direct resume evidence matched; retained as a stretch option"],
      supported,
      transferable,
      gaps,
      discovery: { category, titleExpansions },
      applyUrl: job.url,
      ...jobAge(job),
      score,
      index,
    });
  }
  ranked.sort((left, right) => right.selectedScore - left.selectedScore || fitRank(right.fit) - fitRank(left.fit) || right.score - left.score || freshness(right.job) - freshness(left.job) || left.index - right.index);
  const matches = ranked.slice(0, Math.max(0, limit)).map(({ score: _score, index: _index, ...match }) => match);
  return {
    matches,
    filteredOut,
    assumptions: [
      ...(intent.countries?.length ? [] : ["No positive target country was requested"]),
      ...(intent.roles?.length ? [] : [inferredRoleTargets(profile).length ? "No explicit role intent was supplied; resume role evidence guided ordering" : "No role intent or resume role evidence was available"]),
      ...(typeof intent.remote === "boolean" ? [] : ["No work-mode preference was requested"]),
    ],
    exploration: {
      roleFamilies,
      directMatches: matches.filter((match) => match.discovery.category === "direct"),
      hiddenMatches: matches.filter((match) => match.discovery.category === "hidden"),
      stretchMatches: matches.filter((match) => match.discovery.category === "stretch"),
    },
  };
}

function roleAlignment(targets: string[], title: string, explicit: boolean, expansion?: TitleExpansion): { score: number; reason?: string } {
  if (!targets.length) return { score: 0 };
  if (!explicit) {
    const matched = targets.some((target) => tokenOverlap(target, title) >= 0.5);
    if (matched) return { score: 4, reason: "title aligns with resume role evidence" };
    if (expansion) return { score: 3, reason: `title-family expansion surfaced ${expansion.alias} from ${expansion.family} evidence` };
    return { score: 0 };
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
  if (expansion) return { score: 3, reason: `title-family expansion surfaced ${expansion.alias} from ${expansion.family} evidence` };
  return { score: best };
}

const titleAliases: Record<RoleFamily, string[]> = {
  backend: ["platform engineer", "api engineer", "api developer", "distributed systems engineer", "server-side engineer", "services engineer", "software engineer", "software developer", "application developer"],
  frontend: ["ui engineer", "web engineer", "web developer", "client engineer", "software engineer"],
  data: ["data engineer", "analytics engineer", "machine learning engineer", "ml engineer", "data platform engineer"],
  infrastructure: ["infrastructure engineer", "cloud engineer", "devops engineer", "site reliability engineer", "sre", "platform engineer"],
};

function deriveRoleFamilies(profile: CandidateProfile, intent: CandidateIntent): RoleFamilyExpansion[] {
  const explicit = new Set<RoleFamily>();
  for (const role of intent.roles ?? []) {
    if (/\b(?:backend|api|server-side|distributed systems)\b/iu.test(role)) explicit.add("backend");
    if (/\b(?:frontend|front-end|ui|web)\b/iu.test(role)) explicit.add("frontend");
    if (/\b(?:data|analytics|machine learning|ml)\b/iu.test(role)) explicit.add("data");
    if (/\b(?:infrastructure|cloud|devops|site reliability|sre)\b/iu.test(role)) explicit.add("infrastructure");
    if (includesPhrase(role, "platform engineer")) { explicit.add("backend"); explicit.add("infrastructure"); }
  }
  const inferred = new Map<RoleFamily, string[]>();
  for (const inference of profile.inferences) if (inference.kind === "role_family") inferred.set(inference.value, inference.derivedFromFactIds);
  const expansions: RoleFamilyExpansion[] = [];
  for (const family of ["backend", "frontend", "data", "infrastructure"] as const) {
    if (explicit.has(family)) { expansions.push({ family, aliases: titleAliases[family], derivedFrom: "explicit_intent", evidenceFactIds: [] }); continue; }
    const evidenceFactIds = inferred.get(family);
    if (evidenceFactIds) expansions.push({ family, aliases: titleAliases[family], derivedFrom: "resume_evidence", evidenceFactIds });
  }
  return expansions;
}

function matchTitleExpansions(families: RoleFamilyExpansion[], job: Job): TitleExpansion[] {
  const matches = families.flatMap((family) => family.aliases
    .filter((alias) => includesPhrase(job.title, alias) && aliasCorroborated(family.family, alias, job.description))
    .map((alias) => ({ family: family.family, alias, derivedFrom: family.derivedFrom, evidenceFactIds: family.evidenceFactIds })));
  return matches.sort((left, right) => Number(right.derivedFrom === "explicit_intent") - Number(left.derivedFrom === "explicit_intent")
    || right.evidenceFactIds.length - left.evidenceFactIds.length || left.family.localeCompare(right.family) || left.alias.localeCompare(right.alias));
}

const genericAliases = new Set(["software engineer", "software developer"]);
const familySignals: Record<RoleFamily, string[]> = {
  backend: ["backend", "api", "java", "golang", "python", "node.js", "spring", "microservices", "distributed systems"],
  frontend: ["frontend", "front-end", "javascript", "typescript", "react", "angular", "vue", "css"],
  data: ["data pipeline", "analytics", "machine learning", "spark", "airflow", "dbt", "snowflake"],
  infrastructure: ["infrastructure", "cloud", "aws", "azure", "gcp", "kubernetes", "terraform", "site reliability", "devops"],
};
function aliasCorroborated(family: RoleFamily, alias: string, description: string): boolean {
  return !genericAliases.has(alias) || familySignals[family].some((signal) => includesPhrase(description, signal));
}

function directTitleMatch(targets: string[], title: string): boolean {
  return targets.some((target) => includesPhrase(title, target) || tokenOverlap(target, title) === 1);
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
  // The recommender walks the windows itself and always passes an explicit value; a bare call keeps the 30-day default with undated roles allowed.
  const explicitAge = intent.maxAgeDays !== undefined;
  const maxAgeDays = explicitAge ? intent.maxAgeDays! : DEFAULT_MAX_AGE_DAYS;
  if (maxAgeDays > 0 && !withinWindow(job, maxAgeDays, Date.now()) && (explicitAge || postedTime(job) > 0)) reasons.push(`posted_too_old:${maxAgeDays}d`);
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
  const jobSeniority = seniorityTerms.find((term) => includesPhrase(job.title, term));
  if (!jobSeniority) return { score: 0 };
  if (!requested.length) {
    const years = profile.inferences.find((inference) => inference.kind === "approximate_experience_years")?.value;
    if (typeof years !== "number") return { score: 0 };
    const aligned = experienceAlignsWithSeniority(years, jobSeniority);
    return { score: aligned ? 2 : -2, reason: aligned ? `seniority aligns with resume experience evidence: ${jobSeniority}` : `seniority differs from resume experience evidence: ${jobSeniority}` };
  }
  if (requested.includes(jobSeniority)) return { score: 2, reason: `${intent.seniority?.length ? "seniority matches explicit intent" : "seniority aligns with resume evidence"}: ${jobSeniority}` };
  return { score: -2, reason: `seniority differs from ${intent.seniority?.length ? "explicit intent" : "resume evidence"}: ${jobSeniority}` };
}

function experienceAlignsWithSeniority(years: number, seniority: typeof seniorityTerms[number]): boolean {
  if (seniority === "intern" || seniority === "junior") return years <= 2;
  if (seniority === "mid") return years >= 2 && years <= 6;
  const minimums: Partial<Record<typeof seniorityTerms[number], number>> = { senior: 5, lead: 6, staff: 7, principal: 8, manager: 6 };
  return years >= (minimums[seniority] ?? 0);
}

function evidencePercent(
  role: { score: number }, roleTargets: string[], seniority: { score: number }, supported: SupportedRequirement[], transferable: TransferableRequirement[], gaps: string[], screening: ScreeningRequirement[],
): number {
  const requirements = new Set([...supported, ...transferable].map((item) => item.requirement.toLocaleLowerCase()));
  for (const gap of gaps) requirements.add(gap.toLocaleLowerCase());
  const rolePoints = !roleTargets.length ? 0 : role.score >= 4 ? 30 : role.score >= 3 ? 22.5 : 0;
  const requirementPoints = requirements.size
    ? ((supported.length + transferable.length * 0.5) / requirements.size) * 50
    : 0;
  const screeningPoints = screening.length
    ? ((screening.filter((item) => item.status === "supported").length + screening.filter((item) => item.status === "partial").length * 0.5) / screening.length) * 20
    : seniority.score > 0 ? 20 : seniority.score < 0 ? 0 : 10;
  const raw = Math.round(rolePoints + requirementPoints + screeningPoints);
  return screening.some((item) => item.status !== "supported") ? Math.min(raw, 79) : Math.min(raw, 100);
}

function keywordPercent(profile: CandidateProfile, job: Job, screening: ScreeningRequirement[]): number {
  const searchable = profile.normalizedResume.text;
  const titleKeywords = (job.title.toLocaleLowerCase().match(/[a-z0-9+#.]+/g) ?? [])
    .filter((token) => token.length > 2 && !keywordStopWords.has(token));
  const catalogKeywords = detectRequirementTerms(job.description);
  const screeningKeywords = screening.map((item) => item.requirement);
  const keywords = uniqueTerms([...titleKeywords, ...catalogKeywords, ...screeningKeywords]);
  if (!keywords.length) return 0;
  const matched = keywords.filter((keyword) => includesPhrase(searchable, keyword) || hyphenatedPhrase(searchable, keyword)).length;
  const raw = Math.round((matched / keywords.length) * 100);
  return screening.some((item) => item.status !== "supported") ? Math.min(raw, 79) : raw;
}

const keywordStopWords = new Set(["engineer", "engineering", "developer", "development", "senior", "staff", "principal", "lead", "technology"]);

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
  return detectRequirementTerms(requirementText);
}

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
  if (/^(?:what(?:'|’)s required|required qualifications?|requirements?|qualifications?|minimum qualifications?|essentials?|essential qualifications?|must haves?|your experience includes)$/i.test(heading)) return "required";
  if (/^(?:preferred qualifications?|optional requirements?|nice to have)$/i.test(heading)) return "optional";
  if (/^(?:what you(?:'|’)ll do|responsibilities|we take care of our people|benefits|about .+)$/i.test(heading)) return "other";
  return undefined;
}

function hyphenatedPhrase(value: string, phrase: string): boolean {
  if (phrase.trim().toLocaleLowerCase() === "go") return false;
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
  return profile.facts.filter((fact) => requiresExactSkillEvidence(requirement)
    ? fact.kind === "skill" && matchesExactSkillEvidence(requirement, fact.value)
    : fact.kind !== "certification" && includesPhrase(fact.value, requirement));
}

function inferredRoleTargets(profile: CandidateProfile): string[] {
  const roles = profile.facts.filter((fact) => fact.kind === "role").map((fact) => fact.value);
  const families = profile.inferences.filter((inference) => inference.kind === "role_family").map((inference) => `${inference.value} engineer`);
  return [...roles, ...families];
}

function transferableRequirements(profile: CandidateProfile, requirements: string[], supported: SupportedRequirement[]): TransferableRequirement[] {
  const skills = profile.facts.filter((fact) => fact.kind === "skill");
  return requirements.flatMap((requirement) => {
    if (supported.some((item) => equalSkill(item.requirement, requirement))) return [];
    const match = findTransferability(requirement, skills);
    return match ? [{ requirement, ...match }] : [];
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
function includesPhrase(value: string, phrase: string): boolean {
  const normalizedPhrase = phrase.trim().toLocaleLowerCase();
  if (!normalizedPhrase) return false;
  if (normalizedPhrase === "go") {
    const withoutProseIdioms = value.replace(/\b(?:go-to-market|go-live|on-the-go)\b/gi, " ");
    return /(^|[^a-z0-9+#])Go(?=$|[^a-z0-9+#])/.test(withoutProseIdioms);
  }
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

const freshness = postedTime;
