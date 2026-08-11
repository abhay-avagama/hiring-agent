import { parseCandidateProfile, type CandidateProfile, type ResumeInput } from "./candidate-profile.ts";
import { matchJobs, type CandidateIntent, type SupportedRequirement, type TransferableRequirement } from "./job-matching.ts";
import { assertKnownKeys, isRecord, validateCandidateIntent } from "./intent-validation.ts";
import type { Job } from "./types.ts";
import { evaluateScreeningRequirements, type ScreeningRequirement } from "./screening-requirements.ts";

export interface AnalyzeJobFitInput { jobId: string; resume: ResumeInput; intent?: CandidateIntent }
export interface JobFitReason {
  claim: string;
  candidateFactIds?: string[];
  jobEvidence: { field: "title" | "description" | "eligibility" | "location" | "workMode" | "company"; quote: string; start?: number; end?: number };
}
export interface JobFitAssessment { fit: "strong" | "good" | "stretch" | "poor"; reasons: JobFitReason[] }
export interface PartiallySupportedRequirement extends SupportedRequirement {
  via: TransferableRequirement["via"] | "experience_below_requirement";
}
export interface AnalyzeJobFitResult {
  job: Job;
  profile: CandidateProfile;
  supported: SupportedRequirement[];
  partiallySupported: PartiallySupportedRequirement[];
  unsupported: string[];
  screeningRisks: string[];
  interviewPreparationGaps: string[];
  assessment: JobFitAssessment;
}

export interface JobFitAnalyzerOptions { getJob(id: string): Promise<Job | null> }

export class JobFitAnalysisError extends Error {
  constructor(readonly code: "invalid_job_fit_input" | "job_not_found", message: string, readonly field?: string) { super(message); }
}

export function createJobFitAnalyzer(options: JobFitAnalyzerOptions) {
  return {
    async analyze(value: unknown): Promise<AnalyzeJobFitResult> {
      const input = validateJobFitInput(value);
      const profile = parseCandidateProfile(input.resume);
      const job = await options.getJob(input.jobId);
      if (!job) throw new JobFitAnalysisError("job_not_found", `Unknown job: ${input.jobId}`, "jobId");
      const intent = input.intent ?? {};
      const filtered = matchJobs(profile, intent, [job], 1);
      const relevance = filtered.matches[0] ?? matchJobs(profile, softIntent(intent), [job], 1).matches[0]!;
      const screening = evaluateScreeningRequirements(profile, job);
      const structured = structuredRequirements(job, profile, screening);
      const supported = mergeSupported(relevance.supported, structured.supported);
      const partiallySupported = mergePartial(relevance.transferable, structured.partial);
      const resolved = new Set([...supported, ...partiallySupported].map((item) => item.requirement.toLocaleLowerCase()));
      const certificationRequirements = [...structured.supported.map((item) => item.requirement), ...structured.unsupported]
        .filter((item) => item.toLocaleLowerCase().endsWith(" certification"));
      const matchingGaps = relevance.gaps.filter((gap) => !certificationRequirements.some((item) => item.toLocaleLowerCase() === `${gap.toLocaleLowerCase()} certification`));
      const unsupported = compactRequirements(unique([...matchingGaps, ...structured.unsupported])
        .filter((requirement) => !resolved.has(requirement.toLocaleLowerCase()))
        .filter((requirement) => !supported.some((item) => item.requirement.toLocaleLowerCase() === `${requirement.toLocaleLowerCase()} certification`)));
      const hardRisks = filtered.filteredOut.flatMap((candidate) => candidate.reasons.map(describeFilterRisk));
      const requirementRisks = unsupported.map((requirement) =>
        requirement.startsWith("Work authorization in ")
          ? `Work authorization is required but cannot be inferred from resume silence or geographic intent: ${requirement.slice("Work authorization in ".length)}`
          : screening.some((item) => item.requirement === requirement)
            ? `Resume does not provide evidence satisfying mandatory ${screening.find((item) => item.requirement === requirement)!.kind} requirement: ${requirement}`
          : `No explicit or transferable resume evidence supports required skill: ${requirement}`,
      );
      const partialScreeningRisks = screening.filter((item) => item.status === "partial").map((item) => `Resume evidence does not meet minimum requirement: ${item.requirement}`);
      const seniorityRisks = relevance.reasons.filter((reason) => reason.startsWith("seniority differs"));
      const screeningRisks = [...hardRisks, ...seniorityRisks, ...partialScreeningRisks, ...requirementRisks];
      const fit = hardRisks.length || screening.some((item) => item.status !== "supported") || (!supported.length && !partiallySupported.length && unsupported.length)
        ? "poor"
        : relevance.fit === "strong" && unsupported.length ? "good" : relevance.fit;
      return {
        job,
        profile,
        supported,
        partiallySupported,
        unsupported,
        screeningRisks,
        interviewPreparationGaps: [
          ...partiallySupported.map((item) => `Prepare examples connecting ${item.via} evidence to the ${item.requirement} requirement without claiming direct experience`),
          ...unsupported.map((requirement) => `Prepare a truthful response about the unsupported ${requirement} requirement; do not add it to the resume as experience`),
        ],
        assessment: {
          fit,
          reasons: assessmentReasons(job, profile, relevance.reasons, screeningRisks, supported, partiallySupported),
        },
      };
    },
  };
}

function structuredRequirements(job: Job, profile: CandidateProfile, screening: ScreeningRequirement[]): {
  supported: SupportedRequirement[];
  partial: PartiallySupportedRequirement[];
  unsupported: string[];
} {
  const supported: SupportedRequirement[] = [];
  const partial: PartiallySupportedRequirement[] = [];
  const unsupported: string[] = [];
  const text = job.description;

  for (const item of screening) {
    if (item.status === "supported") supported.push({ requirement: item.requirement, factIds: item.factIds });
    else if (item.status === "partial") partial.push({ requirement: item.requirement, via: "experience_below_requirement", factIds: item.factIds });
    else unsupported.push(item.requirement);
  }

  for (const match of text.matchAll(/\b(?:authorized|authorization)\s+to\s+work\s+in\s+([A-Za-z][A-Za-z ]{1,30}?)(?=[.,;\n]|\s+(?:is|required|must)\b)/gi)) {
    const country = match[1]!.trim();
    unsupported.push(`Work authorization in ${country}`);
  }

  for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9+.#-]{1,30})\s+certification\s+(?:is\s+)?(?:required|mandatory|must)\b/gi)) {
    const name = match[1]!;
    const label = `${name} certification`;
    const fact = profile.facts.find((item) => item.kind === "certification" && includesTerm(item.value, name));
    if (fact) supported.push({ requirement: label, factIds: [fact.id] }); else unsupported.push(label);
  }
  unsupported.push(...explicitRequirementLabels(text));
  return { supported, partial, unsupported };
}

function explicitRequirementLabels(text: string): string[] {
  const labels: string[] = [];
  for (const sentence of text.split(/[.!?\n;]+/).map((value) => value.trim()).filter(Boolean)) {
    const suffix = /^(.+?)\s+(?:is|are)\s+(?:strictly\s+)?required$/i.exec(sentence)?.[1];
    const must = /^(?:candidates?\s+)?must\s+(?:have|possess|demonstrate)?\s*(.+)$/i.exec(sentence)?.[1];
    const value = suffix ?? must;
    if (!value || /\b(?:authorized|authorization)\s+to\s+work\b/i.test(value)) continue;
    for (const atom of value.split(/,|\band\b/i)) {
      const label = atom.trim().replace(/^(?:a|an|the|minimum of)\s+/i, "").replace(/^(?:experience|proficiency)\s+(?:with|in)\s+/i, "").trim();
      if (label.length >= 2) labels.push(label[0]!.toUpperCase() + label.slice(1));
    }
  }
  return unique(labels);
}

function assessmentReasons(job: Job, profile: CandidateProfile, matchingReasons: string[], risks: string[], supported: SupportedRequirement[], partial: PartiallySupportedRequirement[]): JobFitReason[] {
  const result: JobFitReason[] = [];
  for (const item of [...supported, ...partial]) {
    result.push({ claim: `${item.requirement} is supported to the stated degree by resume evidence`, candidateFactIds: item.factIds, jobEvidence: jobDescriptionEvidence(job, item.requirement) });
  }
  for (const reason of matchingReasons.filter((value) => value.includes("title") || value.startsWith("seniority"))) {
    const resumeGroundedIds = reason.startsWith("seniority")
      ? profile.inferences.filter((item) => item.kind === "seniority").flatMap((item) => item.derivedFromFactIds)
      : reason === "title aligns with resume role evidence"
        ? [...profile.facts.filter((item) => item.kind === "role").map((item) => item.id), ...profile.inferences.filter((item) => item.kind === "role_family").flatMap((item) => item.derivedFromFactIds)]
        : [];
    result.push({ claim: reason, ...(resumeGroundedIds.length ? { candidateFactIds: unique(resumeGroundedIds) } : {}), jobEvidence: { field: "title", quote: job.title, start: 0, end: job.title.length } });
  }
  for (const risk of risks) {
    const riskFactIds = risk.startsWith("seniority differs")
      ? profile.inferences.filter((item) => item.kind === "seniority").flatMap((item) => item.derivedFromFactIds)
      : partial.filter((item) => risk.includes(item.requirement)).flatMap((item) => item.factIds);
    result.push({ claim: risk, ...(riskFactIds.length ? { candidateFactIds: unique(riskFactIds) } : {}), jobEvidence: evidenceForRisk(job, risk) });
  }
  return result;
}

function evidenceForRisk(job: Job, risk: string): JobFitReason["jobEvidence"] {
  if (/country/i.test(risk)) return { field: "eligibility", quote: JSON.stringify({ eligibleCountries: job.eligibleCountries, excludedCountries: job.excludedCountries }) };
  if (/location/i.test(risk)) return { field: "location", quote: job.location };
  if (/excluded role/i.test(risk) || risk.startsWith("seniority differs")) return { field: "title", quote: job.title, start: 0, end: job.title.length };
  if (/remote|work-mode/i.test(risk)) return { field: "workMode", quote: job.workMode };
  if (/excluded term/i.test(risk)) {
    const term = risk.split(":", 2)[1]?.trim() ?? "";
    for (const [field, value] of [["title", job.title], ["company", job.company], ["location", job.location], ["description", job.description]] as const) {
      const start = value.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
      if (start >= 0) return { field, quote: value.slice(start, start + term.length), start, end: start + term.length };
    }
  }
  return jobDescriptionEvidence(job, riskRequirement(risk));
}

function riskRequirement(risk: string): string {
  return risk.match(/required skill: (.+)$/)?.[1] ?? risk.match(/intent: (.+)$/)?.[1] ?? "";
}

function jobDescriptionEvidence(job: Job, requirement: string): JobFitReason["jobEvidence"] {
  const start = requirement ? job.description.toLocaleLowerCase().indexOf(requirement.toLocaleLowerCase()) : -1;
  if (start >= 0) return { field: "description", quote: job.description.slice(start, start + requirement.length), start, end: start + requirement.length };
  return { field: "description", quote: job.description };
}

function includesTerm(value: string, term: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9+.#])${escapeRegex(term)}(?=$|[^A-Za-z0-9+.#])`, "i").test(value);
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function compactRequirements(values: string[]): string[] {
  return values.filter((value, index) => !values.some((other, otherIndex) => otherIndex !== index && other.length < value.length && includesTerm(value, other)));
}
function mergeSupported(...groups: SupportedRequirement[][]): SupportedRequirement[] {
  const merged = new Map<string, SupportedRequirement>();
  for (const item of groups.flat()) {
    const key = item.requirement.toLocaleLowerCase();
    const existing = merged.get(key);
    if (existing) existing.factIds = unique([...existing.factIds, ...item.factIds]); else merged.set(key, { ...item, factIds: [...item.factIds] });
  }
  return [...merged.values()];
}
function mergePartial(...groups: PartiallySupportedRequirement[][]): PartiallySupportedRequirement[] {
  const merged = new Map<string, PartiallySupportedRequirement>();
  for (const item of groups.flat()) if (!merged.has(item.requirement.toLocaleLowerCase())) merged.set(item.requirement.toLocaleLowerCase(), item);
  return [...merged.values()];
}

function validateJobFitInput(value: unknown): AnalyzeJobFitInput {
  if (!isRecord(value)) throw invalidFitInput("input", "Job fit input must be an object");
  assertKnownKeys(value, ["jobId", "resume", "intent"], "input", invalidFitInput);
  if (typeof value.jobId !== "string" || !value.jobId.trim()) throw invalidFitInput("jobId", "jobId must be a non-empty string");
  if (!isRecord(value.resume)) throw invalidFitInput("resume", "Resume input must be an object");
  assertKnownKeys(value.resume, ["content", "format"], "resume", invalidFitInput);
  const intent = validateCandidateIntent(value.intent, invalidFitInput, { optional: true });
  return { jobId: value.jobId, resume: value.resume as unknown as ResumeInput, ...(value.intent === undefined ? {} : { intent }) };
}

function invalidFitInput(field: string, message: string): JobFitAnalysisError {
  return new JobFitAnalysisError("invalid_job_fit_input", message, field);
}

function softIntent(intent: CandidateIntent): CandidateIntent {
  const { countries: _countries, locations: _locations, remote: _remote, excludedCountries: _excludedCountries, excludedLocations: _excludedLocations, excludedRoles: _excludedRoles, excludedTerms: _excludedTerms, ...soft } = intent;
  return soft;
}

function describeFilterRisk(reason: string): string {
  const [kind, detail] = reason.split(":", 2);
  const descriptions: Record<string, string> = {
    country_not_eligible: `Job is not eligible for requested country: ${detail}`,
    country_excluded: `Job is eligible in an excluded country: ${detail}`,
    location_mismatch: "Job location does not match explicit location intent",
    location_excluded: `Job is in an excluded location: ${detail}`,
    role_excluded: `Job matches an excluded role: ${detail}`,
    remote_required: "Job is not explicitly remote",
    non_remote_required: "Job does not satisfy explicit non-remote intent",
    excluded_term: `Job contains an excluded term: ${detail}`,
  };
  return descriptions[kind ?? ""] ?? reason;
}
