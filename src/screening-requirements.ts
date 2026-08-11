import type { CandidateProfile } from "./candidate-profile.ts";
import type { Job } from "./types.ts";

export interface ScreeningRequirement {
  kind: "experience" | "education";
  requirement: string;
  status: "supported" | "partial" | "unsupported";
  factIds: string[];
}

export function evaluateScreeningRequirements(profile: CandidateProfile, job: Job): ScreeningRequirement[] {
  const description = normalizeStructuredText(job.description);
  const requirements = [
    ...experienceRequirements(profile, description),
    ...educationRequirements(profile, description),
  ];
  return [...new Map(requirements.map((item) => [`${item.kind}:${item.requirement.toLocaleLowerCase()}`, item])).values()];
}

function normalizeStructuredText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|\u00a0/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ");
}

function experienceRequirements(profile: CandidateProfile, description: string): ScreeningRequirement[] {
  const pattern = /\b(\d+)\s*\+?\s*years?\s+(?:of\s+)?(?:[A-Za-z][A-Za-z/-]*\s+){0,6}?experience\b/gi;
  return [...description.matchAll(pattern)].flatMap<ScreeningRequirement>((match) => {
    if (!isMandatory(description, match.index!, match[0])) return [];
    const requirement = clean(match[0]);
    const inference = profile.inferences.find((value) => value.kind === "approximate_experience_years");
    if (!inference) return [{ kind: "experience", requirement, status: "unsupported", factIds: [] }];
    return [{
      kind: "experience",
      requirement,
      status: inference.value >= Number(match[1]) ? "supported" : "partial",
      factIds: inference.derivedFromFactIds,
    }];
  });
}

function educationRequirements(profile: CandidateProfile, description: string): ScreeningRequirement[] {
  const fieldPattern = /\b((?:bachelor|master)(?:['’]s)?(?:\s+or\s+(?:bachelor|master)(?:['’]s)?)*)\s+degree\s+in\s+([^.\n]+)/gi;
  const fieldSpecific = [...description.matchAll(fieldPattern)].flatMap((match) => {
    if (!isMandatory(description, match.index!, match[0])) return [];
    const levels = [...match[1]!.matchAll(/bachelor|master/gi)].map((value) => value[0]!.toLocaleLowerCase());
    const fact = profile.facts.find((value) => value.kind === "education" && levels.some((level) => educationLevelMatches(level, value.value)) && educationFieldMatches(match[2]!, value.value));
    return [{ kind: "education", requirement: clean(match[0]), status: fact ? "supported" : "unsupported", factIds: fact ? [fact.id] : [] } satisfies ScreeningRequirement];
  });
  const genericPattern = /\b(bachelor(?:['’]s)?|master(?:['’]s)?|ph\.?d\.?|doctorate)\s+degree\b[^.\n]{0,30}\b(?:required|minimum|must)\b/gi;
  const generic = [...description.matchAll(genericPattern)].flatMap<ScreeningRequirement>((match) => {
    if (!isMandatory(description, match.index!, match[0])) return [];
    const level = match[1]!.toLocaleLowerCase();
    const fact = profile.facts.find((value) => value.kind === "education" && educationLevelMatches(level, value.value));
    const requirement = level.startsWith("bachelor") ? "Bachelor's degree" : level.startsWith("master") ? "Master's degree" : "Doctoral degree";
    return [{ kind: "education", requirement, status: fact ? "supported" : "unsupported", factIds: fact ? [fact.id] : [] }];
  });
  return [...fieldSpecific, ...generic];
}

function isMandatory(description: string, start: number, value: string): boolean {
  const clauseEnd = description.slice(start).search(/[.\n]/);
  const clause = description.slice(start, clauseEnd < 0 ? undefined : start + clauseEnd);
  const rawPrefix = description.slice(Math.max(0, start - 40), start);
  const prefix = rawPrefix.slice(Math.max(rawPrefix.lastIndexOf("."), rawPrefix.lastIndexOf("\n")) + 1);
  const context = `${prefix} ${value} ${clause}`;
  if (/\b(?:preferred|optional|desired|nice to have|not required|up to)\b/i.test(context)) return false;
  if (/\b(?:required|must|minimum|at least)\b/i.test(context)) return true;
  return lastSectionKind(description.slice(0, start)) === "required";
}

function lastSectionKind(value: string): "required" | "optional" | undefined {
  let kind: "required" | "optional" | undefined;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim().replace(/:$/, "");
    if (/^(?:preferred qualifications?|optional requirements?|nice to have|extra awesome|optional)$/i.test(line)) kind = "optional";
    else if (/^(?:what(?:'|’)s required|requirements?|qualifications?|required qualifications|minimum qualifications?|essentials?|essential qualifications?|must haves?|your experience includes)$/i.test(line)) kind = "required";
  }
  return kind;
}

function clean(value: string): string { return value.trim().replace(/\s+/g, " "); }

function educationLevelMatches(level: string, value: string): boolean {
  if (level.startsWith("bachelor")) return /\b(?:bachelor|b\.?\s*(?:tech|e|sc|a|com|ba|eng))\b/i.test(value);
  if (level.startsWith("master")) return /\b(?:master|m\.?\s*(?:tech|e|sc|a|com|ba|eng))\b/i.test(value);
  return /\b(?:ph\.?d|doctorate)\b/i.test(value);
}

function educationFieldMatches(requiredField: string, value: string): boolean {
  const candidate = value.toLocaleLowerCase();
  if (/\b(?:computer science|computing|software|information technology|engineering)\b/i.test(requiredField) && /\b(?:computer science|computing|software|information technology|engineering|b\.?tech|b\.?e\.?|m\.?tech|m\.?e\.?)\b/i.test(candidate)) return true;
  if (/\b(?:technical|business)\b/i.test(requiredField) && /\b(?:technology|technical|engineering|computer|software|information systems|business|commerce|bba|mba|b\.?tech|m\.?tech)\b/i.test(candidate)) return true;
  return false;
}
