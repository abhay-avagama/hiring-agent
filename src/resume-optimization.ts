import type { CandidateProfile, NormalizedResume, ResumeInput } from "./candidate-profile.ts";
import type { AnalyzeJobFitResult, JobFitReason } from "./job-fit-analysis.ts";
import { assertKnownKeys, isRecord } from "./intent-validation.ts";
import type { Job } from "./types.ts";

export type ResumeOptimizationOutput = "suggestions" | "unified_diff" | "revised_markdown";
export interface OptimizeResumeInput { jobId: string; resume: ResumeInput; output: ResumeOptimizationOutput }
export interface ResumeSuggestion {
  action: "elevate";
  proposedText: string;
  factIds: string[];
  jobEvidence: JobFitReason["jobEvidence"];
  rationale: string;
}
export interface OptimizeResumeResult {
  job: Job;
  profile: CandidateProfile;
  output: ResumeOptimizationOutput;
  suggestions: ResumeSuggestion[];
  gaps: string[];
  content?: string;
  diffBase?: NormalizedResume;
  originalOverwritten: false;
}
export interface ResumeOptimizerOptions { analyzeJobFit(input: unknown): Promise<AnalyzeJobFitResult> }

export class ResumeOptimizationError extends Error {
  constructor(readonly code: "invalid_resume_optimization_input", message: string, readonly field?: string) { super(message); }
}

export function createResumeOptimizer(options: ResumeOptimizerOptions) {
  return {
    async optimize(value: unknown): Promise<OptimizeResumeResult> {
      const input = validateInput(value);
      const analysis = await options.analyzeJobFit({ jobId: input.jobId, resume: input.resume });
      const facts = new Map(analysis.profile.facts.map((fact) => [fact.id, fact]));
      const suggestions: ResumeSuggestion[] = [];
      const used = new Set<string>();
      for (const support of analysis.supported) {
        const jobReason = analysis.assessment.reasons.find((candidate) => candidate.candidateFactIds?.some((id) => support.factIds.includes(id)));
        for (const fact of analysis.profile.facts.filter((candidate) => achievementFactKinds.has(candidate.kind) && includesPhrase(candidate.value, support.requirement))) {
          if (used.has(fact.id)) continue;
          used.add(fact.id);
          suggestions.push({
            action: "elevate",
            proposedText: fact.value,
            factIds: [fact.id],
            jobEvidence: jobReason?.jobEvidence ?? { field: "description", quote: analysis.job.description },
            rationale: `Elevate this complete existing achievement because it demonstrates ${support.requirement}`,
          });
        }
        for (const factId of support.factIds) {
          const fact = facts.get(factId);
          if (!fact || !editableFactKinds.has(fact.kind) || used.has(fact.id)) continue;
          used.add(fact.id);
          suggestions.push({
            action: "elevate",
            proposedText: fact.value,
            factIds: [fact.id],
            jobEvidence: jobReason?.jobEvidence ?? { field: "description", quote: analysis.job.description },
            rationale: `Elevate this existing resume fact because it directly supports ${support.requirement}`,
          });
        }
      }
      return {
        job: analysis.job,
        profile: analysis.profile,
        output: input.output,
        suggestions,
        gaps: analysis.unsupported,
        ...(input.output === "revised_markdown" ? { content: revisedMarkdown(analysis.profile.normalizedResume.text, suggestions) } : {}),
        ...(input.output === "unified_diff" ? { content: unifiedDiff(analysis.profile.normalizedResume.text, suggestions) } : {}),
        ...(input.output === "unified_diff" ? { diffBase: analysis.profile.normalizedResume } : {}),
        originalOverwritten: false,
      };
    },
  };
}

const editableFactKinds = new Set(["skill", "outcome", "experience_statement", "project", "project_statement", "education", "certification"]);
const achievementFactKinds = new Set(["outcome", "experience_statement", "project_statement"]);

function includesPhrase(value: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9+.#])${escaped}(?=$|[^A-Za-z0-9+.#])`, "i").test(value);
}

function revisedMarkdown(original: string, suggestions: ResumeSuggestion[]): string {
  if (!suggestions.length) return original;
  return `# Targeted Highlights\n\n${suggestions.map((suggestion) => `- ${suggestion.proposedText}`).join("\n")}\n\n${original}`;
}

function unifiedDiff(original: string, suggestions: ResumeSuggestion[]): string {
  if (!suggestions.length) return "";
  const originalLines = original.split("\n");
  const inserted = ["# Targeted Highlights", "", ...suggestions.map((suggestion) => `- ${suggestion.proposedText}`), ""];
  return [
    "--- resume",
    "+++ resume.optimized.md",
    `@@ -1,${originalLines.length} +1,${originalLines.length + inserted.length} @@`,
    ...inserted.map((line) => `+${line}`),
    ...originalLines.map((line) => ` ${line}`),
  ].join("\n");
}

function validateInput(value: unknown): OptimizeResumeInput {
  if (!isRecord(value)) throw invalid("input", "Resume optimization input must be an object");
  assertKnownKeys(value, ["jobId", "resume", "output"], "input", invalid);
  if (typeof value.jobId !== "string" || !value.jobId.trim()) throw invalid("jobId", "jobId must be a non-empty string");
  if (!isRecord(value.resume)) throw invalid("resume", "Resume input must be an object");
  assertKnownKeys(value.resume, ["content", "format"], "resume", invalid);
  if (!(["suggestions", "unified_diff", "revised_markdown"] as unknown[]).includes(value.output)) throw invalid("output", "output must be suggestions, unified_diff, or revised_markdown");
  return { jobId: value.jobId, resume: value.resume as unknown as ResumeInput, output: value.output as ResumeOptimizationOutput };
}

function invalid(field: string, message: string): ResumeOptimizationError {
  return new ResumeOptimizationError("invalid_resume_optimization_input", message, field);
}
