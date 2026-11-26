import type { ResumeInput } from "./candidate-profile.ts";
import type { AnalyzeJobFitResult } from "./job-fit-analysis.ts";
import { assertKnownKeys, isRecord } from "./intent-validation.ts";
import { extractSkills, skillNames } from "./skills.ts";
import type { Job } from "./types.ts";

/**
 * Interview preparation for one role. Openings supplies what only it knows (the fit evidence and what the employer's
 * own live postings show) and a brief; the candidate's AI app does the public research and writes the guide, so
 * nothing here calls a model and the resume is read in memory only, as in analyze_job_fit.
 */
export interface PrepareInterviewInput { jobId: string; resume: ResumeInput; interviewDate?: string; round?: string; minutes?: number }
export interface RelatedRole { id: string; title: string; location: string; postedDaysAgo?: number; sharedSkills: string[] }
export interface EmployerSignals {
  company: string;
  /** Live roles on this employer's board in the Openings index. */
  liveRoles: number;
  /** Skills most often required across those roles: what the employer is building with right now. */
  skills: Array<{ skill: string; roles: number }>;
  locations: Array<{ location: string; roles: number }>;
  /** Other open roles that share this role's skills: likely the same team, product or client build-out. */
  relatedRoles: RelatedRole[];
}
export interface PrepareInterviewResult {
  job: Job;
  fit: Pick<AnalyzeJobFitResult, "assessment" | "supported" | "partiallySupported" | "unsupported" | "screeningRisks">;
  employer: EmployerSignals;
  /** Points the candidate must check against their own records before saying them in the room. */
  verifyBeforeClaiming: string[];
  brief: { plan: Array<{ minutes: string; focus: string }>; sections: string[]; research: string[]; rules: string[] };
  nextActions: string[];
}
export interface InterviewPreparerOptions {
  analyzeJobFit(input: unknown): Promise<AnalyzeJobFitResult>;
  /** Every live job on the board this job came from. */
  employerJobs(job: Job): Promise<Job[]>;
}

export class InterviewPreparationError extends Error {
  constructor(readonly code: "invalid_interview_preparation_input", message: string, readonly field?: string) { super(message); }
}

export function createInterviewPreparer(options: InterviewPreparerOptions) {
  return {
    async prepare(value: unknown): Promise<PrepareInterviewResult> {
      const input = validateInput(value);
      const analysis = await options.analyzeJobFit({ jobId: input.jobId, resume: input.resume });
      const { job } = analysis;
      const employer = employerSignals(job, await options.employerJobs(job));
      const minutes = input.minutes ?? 90;
      return {
        job,
        fit: { assessment: analysis.assessment, supported: analysis.supported, partiallySupported: analysis.partiallySupported, unsupported: analysis.unsupported, screeningRisks: analysis.screeningRisks },
        employer,
        verifyBeforeClaiming: [
          ...analysis.supported.map((item) => `${item.requirement}: the exact version, your own part versus the team's, and one concrete instance you can describe`),
          ...analysis.partiallySupported.map((item) => `${item.requirement}: the resume shows related (${item.via}) evidence only; prepare how it transfers, without claiming direct experience`),
          ...analysis.unsupported.map((requirement) => `${requirement}: the resume does not show this; prepare a truthful answer and how you would close the gap`),
          "Every number on the resume (percentages, users, records, savings): the metric, the before and after, and how it was measured",
        ],
        brief: {
          plan: plan(minutes),
          sections: [
            `What they are hiring for: read the description and the employer signals; state in two lines which skill leads this interview${input.round ? ` (${input.round} round)` : ""}, and which of the candidate's experience to lead with and which to hold back`,
            "Likely project: two or three hypotheses for the product, platform or client this role serves, each tied to evidence (the description, the related roles, a cited public source), each labelled a hypothesis",
            "Technical questions from the skills the description names, weighted by the employer's most required skills; a short model answer each, and the follow-up that tests depth",
            "Resume deep dive: the questions an interviewer will ask about each project on the resume, separating what the resume establishes from what the candidate must fill in (verifyBeforeClaiming)",
            "Hands-on: one or two coding or design exercises in the role's stack, with the approach, edge cases and complexity",
            "Introduction: a 90-second and a 30-second version, leading with the experience this role wants",
            "HR and fit: why this employer, why this role, reasons for moving, gaps, notice and salary, eligibility gaps from screeningRisks",
            "Behavioural: situation, responsibility, action, result, learning, each built on a real incident from the resume, never an invented one",
            "Difficult questions: for each unsupported or partial requirement, an honest answer that shows reasoning instead of bluffing",
            "Questions to ask the interviewer about the project, the stack version, testing and the team",
          ],
          research: [
            `Research ${job.company} from public sources only: its own website, products and case studies, engineering blog, press releases and annual reports, and cite each source used`,
            "Do not present a client, product or project as confirmed unless a public source says so; allocation to a client is usually unknown before joining",
            "Do not use or claim leaked interview questions",
          ],
          rules: [
            "Never invent experience, numbers, versions, dates, stakeholders or outcomes; where the resume is silent, leave a blank for the candidate to fill",
            "Say plainly where the candidate does not meet a stated requirement (degree, years, a named tool) and how to answer it",
            "Keep the guide to what the candidate can rehearse in the time given; prefer reasoning over memorised sentences",
            `Put the candidate's name, the employer and the interview date (${input.interviewDate ?? "ask the candidate"}) at the top of every page if producing a document`,
          ],
        },
        nextActions: [
          "Research the employer from public sources and cite them, then write the guide following brief.sections in order",
          "Offer the guide as a document or PDF the candidate can keep, and offer a spoken mock interview afterwards",
          "Ask the candidate to fill the verifyBeforeClaiming items from their own records before the interview",
        ],
      };
    },
  };
}

function plan(minutes: number): Array<{ minutes: string; focus: string }> {
  // Shares of the 90-minute sequence the sample guides used; scaled to the time the candidate has.
  const steps: Array<[number, string]> = [[5, "Orient: the description, the lead skill, the versions you actually used"], [30, "Core technical questions in the lead skill"], [15, "Supporting skills: data, APIs, testing, tooling"], [15, "Hands-on exercise, out loud"], [15, "Resume deep dive and project scenarios"], [10, "Introduction, HR and a rapid mock"]];
  const scale = minutes / 90;
  let at = 0;
  return steps.map(([share, focus]) => {
    const start = Math.round(at); at += share * scale;
    return { minutes: `${start}–${Math.round(at)}`, focus };
  });
}

function employerSignals(job: Job, jobs: Job[]): EmployerSignals {
  // The index stores stemmed tokens (and no description); a job read on demand has a description instead.
  const skillsOf = (item: Job) => new Set(skillNames(item.skills || extractSkills(item.description)));
  // The role being prepared for has its full description in hand, so one mention of a skill counts.
  const own = new Set([...skillsOf(job), ...skillNames(extractSkills(job.description, 1))]);
  const skillCounts = new Map<string, number>();
  const locationCounts = new Map<string, number>();
  const related: RelatedRole[] = [];
  for (const other of jobs) {
    const skills = skillsOf(other);
    for (const skill of skills) skillCounts.set(skill, (skillCounts.get(skill) ?? 0) + 1);
    if (other.location) locationCounts.set(other.location, (locationCounts.get(other.location) ?? 0) + 1);
    if (other.id === job.id) continue;
    const shared = [...skills].filter((skill) => own.has(skill));
    if (shared.length >= 2) related.push({ id: other.id, title: other.title, location: other.location, postedDaysAgo: other.postedDaysAgo, sharedSkills: shared });
  }
  const top = <T extends string>(counts: Map<T, number>, limit: number) => [...counts].sort((left, right) => right[1] - left[1]).slice(0, limit);
  return {
    company: job.company,
    liveRoles: jobs.length,
    skills: top(skillCounts, 15).map(([skill, roles]) => ({ skill, roles })),
    locations: top(locationCounts, 5).map(([location, roles]) => ({ location, roles })),
    relatedRoles: related.sort((left, right) => right.sharedSkills.length - left.sharedSkills.length).slice(0, 10),
  };
}

function validateInput(value: unknown): PrepareInterviewInput {
  if (!isRecord(value)) throw invalid("input", "Interview preparation input must be an object");
  assertKnownKeys(value, ["jobId", "resume", "interviewDate", "round", "minutes"], "input", invalid);
  if (typeof value.jobId !== "string" || !value.jobId.trim()) throw invalid("jobId", "jobId must be a non-empty string");
  if (!isRecord(value.resume)) throw invalid("resume", "Resume input must be an object");
  assertKnownKeys(value.resume, ["content", "format"], "resume", invalid);
  if (value.minutes !== undefined && (typeof value.minutes !== "number" || value.minutes < 15 || value.minutes > 600)) throw invalid("minutes", "minutes must be between 15 and 600");
  for (const field of ["interviewDate", "round"] as const) if (value[field] !== undefined && typeof value[field] !== "string") throw invalid(field, `${field} must be a string`);
  return { jobId: value.jobId, resume: value.resume as unknown as ResumeInput, interviewDate: value.interviewDate as string | undefined, round: value.round as string | undefined, minutes: value.minutes as number | undefined };
}

function invalid(field: string, message: string): InterviewPreparationError {
  return new InterviewPreparationError("invalid_interview_preparation_input", message, field);
}
