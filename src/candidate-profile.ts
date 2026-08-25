export type ResumeFormat = "text" | "markdown" | "pdf_base64" | "docx_base64";

export interface ResumeInput {
  content: string;
  format: ResumeFormat;
}

export interface NormalizedResume {
  text: string;
  normalization: "openings-resume:v1";
  offsetEncoding: "utf16_code_units";
}

export interface CandidateProfile {
  normalizedResume: NormalizedResume;
  facts: CandidateFact[];
  inferences: CandidateInference[];
}

export interface EvidenceSpan { start: number; end: number; quote: string }
export type CandidateFactKind = "skill" | "role" | "employer" | "date" | "outcome" | "experience_statement" | "project" | "project_statement" | "education" | "certification";
export interface CandidateFact { id: string; kind: CandidateFactKind; value: string; evidence: EvidenceSpan[] }
export type CandidateInference =
  | { kind: "role_family"; value: "backend" | "frontend" | "data" | "infrastructure"; derivedFromFactIds: string[] }
  | { kind: "seniority"; value: "intern" | "junior" | "mid" | "senior" | "lead" | "staff" | "principal" | "manager"; derivedFromFactIds: string[] }
  | { kind: "transferable_skill"; value: "backend_programming" | "frontend_programming" | "data_engineering" | "cloud_infrastructure"; derivedFromFactIds: string[] }
  | { kind: "approximate_experience_years"; value: number; derivedFromFactIds: string[] };
export interface EvidenceValidationResult { valid: boolean; errors: string[] }

export class ResumeInputError extends Error {
  constructor(
    readonly code: "unsupported_resume_format" | "invalid_resume_input",
    message: string,
    readonly format?: ResumeFormat,
    readonly supportedFormats?: Array<"text" | "markdown">,
  ) { super(message); }
}

export function parseCandidateProfile(input: unknown): CandidateProfile {
  if (!isRecord(input) || typeof input.format !== "string" || typeof input.content !== "string") {
    throw new ResumeInputError("invalid_resume_input", "Resume must contain text or Markdown content");
  }
  if (input.format === "pdf_base64" || input.format === "docx_base64") {
    throw new ResumeInputError("unsupported_resume_format", `Resume format ${input.format} is not supported yet`, input.format, ["text", "markdown"]);
  }
  if (!(["text", "markdown"] as string[]).includes(input.format)) {
    throw new ResumeInputError("invalid_resume_input", "Resume must contain text or Markdown content");
  }
  const text = normalizeResumeText(input.content);
  if (!text.trim()) throw new ResumeInputError("invalid_resume_input", "Resume content must not be empty");
  const facts = extractFacts(text);
  return {
    normalizedResume: { text, normalization: "openings-resume:v1", offsetEncoding: "utf16_code_units" },
    facts,
    inferences: deriveInferences(facts),
  };
}

export function validateCandidateProfileEvidence(value: unknown): EvidenceValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["candidate profile must be an object"] };
  const normalized = value.normalizedResume;
  if (!isRecord(normalized) || typeof normalized.text !== "string" || normalized.normalization !== "openings-resume:v1" || normalized.offsetEncoding !== "utf16_code_units") {
    errors.push("candidate profile has invalid normalized resume metadata");
  }
  if (!Array.isArray(value.facts)) errors.push("candidate profile facts must be an array");
  if (!Array.isArray(value.inferences)) errors.push("candidate profile inferences must be an array");
  if (errors.length) return { valid: false, errors };
  const profile = value as unknown as CandidateProfile;
  const validFactKinds = new Set<CandidateFactKind>(["skill", "role", "employer", "date", "outcome", "experience_statement", "project", "project_statement", "education", "certification"]);
  for (const [index, fact] of profile.facts.entries()) {
    if (!isRecord(fact) || typeof fact.id !== "string" || !validFactKinds.has(fact.kind as CandidateFactKind) || typeof fact.value !== "string" || !Array.isArray(fact.evidence)) {
      errors.push(`fact ${index}: invalid fact shape`);
      continue;
    }
    for (const evidence of fact.evidence) {
      if (!isRecord(evidence) || !Number.isInteger(evidence.start) || !Number.isInteger(evidence.end) || typeof evidence.quote !== "string") errors.push(`${fact.id}: invalid evidence shape`);
    }
  }
  for (const [index, inference] of profile.inferences.entries()) {
    if (!isValidInference(inference)) errors.push(`inference ${index}: invalid inference shape`);
  }
  if (errors.length) return { valid: false, errors };
  const ids = new Set<string>();
  for (const fact of profile.facts) {
    if (ids.has(fact.id)) errors.push(`${fact.id}: duplicate fact id`);
    ids.add(fact.id);
    if (!fact.evidence.length) errors.push(`${fact.id}: evidence is required`);
    if (!fact.evidence.some((evidence) => evidence.quote === fact.value)) errors.push(`${fact.id}: fact value is not identical to its evidence`);
    for (const evidence of fact.evidence) {
      const validOffsets = Number.isInteger(evidence.start) && Number.isInteger(evidence.end) && evidence.start >= 0 && evidence.end > evidence.start && evidence.end <= profile.normalizedResume.text.length;
      if (!validOffsets || profile.normalizedResume.text.slice(evidence.start, evidence.end) !== evidence.quote) errors.push(`${fact.id}: evidence span does not match normalized resume`);
    }
  }
  for (const inference of profile.inferences) {
    for (const factId of inference.derivedFromFactIds) if (!ids.has(factId)) errors.push(`${inference.kind}:${inference.value}: inference references missing fact ${factId}`);
  }
  if (JSON.stringify(profile.inferences) !== JSON.stringify(deriveInferences(profile.facts))) errors.push("candidate inferences do not match current facts");
  return { valid: errors.length === 0, errors };
}

function isValidInference(value: unknown): value is CandidateInference {
  if (!isRecord(value) || !Array.isArray(value.derivedFromFactIds) || !value.derivedFromFactIds.every((id) => typeof id === "string")) return false;
  if (value.kind === "role_family") return ["backend", "frontend", "data", "infrastructure"].includes(value.value as string);
  if (value.kind === "seniority") return ["intern", "junior", "mid", "senior", "lead", "staff", "principal", "manager"].includes(value.value as string);
  if (value.kind === "transferable_skill") return ["backend_programming", "frontend_programming", "data_engineering", "cloud_infrastructure"].includes(value.value as string);
  return value.kind === "approximate_experience_years" && typeof value.value === "number" && Number.isFinite(value.value) && value.value >= 0;
}

type RoleFamily = Extract<CandidateInference, { kind: "role_family" }>["value"];
const roleSkills: Record<RoleFamily, Set<string>> = {
  backend: new Set(["java", "go", "golang", "python", "node.js", "nodejs", "postgresql", "postgres", "sql", "spring", "django"]),
  frontend: new Set(["javascript", "typescript", "react", "vue", "angular", "html", "css"]),
  data: new Set(["pandas", "spark", "hadoop", "dbt", "airflow", "snowflake", "machine learning"]),
  infrastructure: new Set(["aws", "azure", "gcp", "kubernetes", "docker", "terraform", "ansible"]),
};

function deriveInferences(facts: CandidateFact[]): CandidateInference[] {
  const skills = facts.filter((fact) => fact.kind === "skill");
  const inferences: CandidateInference[] = (Object.entries(roleSkills) as Array<[RoleFamily, Set<string>]>).flatMap(([value, vocabulary]) => {
    const supporting = skills.filter((fact) => vocabulary.has(fact.value.toLowerCase()));
    return supporting.length ? [{ kind: "role_family", value, derivedFromFactIds: supporting.map((fact) => fact.id) }] : [];
  });
  const roles = facts.filter((fact) => fact.kind === "role");
  const seniorityOrder = ["manager", "principal", "staff", "lead", "senior", "junior", "intern"] as const;
  for (const role of roles) {
    const seniority = seniorityOrder.find((value) => new RegExp(`\\b${value}\\b`, "i").test(role.value));
    if (seniority) inferences.push({ kind: "seniority", value: seniority, derivedFromFactIds: [role.id] });
  }
  const transferable: Array<[RoleFamily, Extract<CandidateInference, { kind: "transferable_skill" }>["value"]]> = [
    ["backend", "backend_programming"], ["frontend", "frontend_programming"], ["data", "data_engineering"], ["infrastructure", "cloud_infrastructure"],
  ];
  for (const [family, value] of transferable) {
    const supporting = skills.filter((fact) => roleSkills[family].has(fact.value.toLowerCase()));
    if (supporting.length) inferences.push({ kind: "transferable_skill", value, derivedFromFactIds: supporting.map((fact) => fact.id) });
  }
  const dateFacts = facts.filter((fact) => fact.kind === "date");
  const hasOpenInterval = dateFacts.some((fact) => /\b(?:present|current)\b/i.test(fact.value));
  const intervals = dateFacts.flatMap((fact) => {
    const years = [...fact.value.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => Number(match[0]));
    return years.length >= 2 && years[1]! >= years[0]! ? [{ start: years[0]!, end: years[1]!, fact }] : [];
  }).sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number; facts: CandidateFact[] }> = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
      previous.facts.push(interval.fact);
    } else merged.push({ start: interval.start, end: interval.end, facts: [interval.fact] });
  }
  if (merged.length && !hasOpenInterval) {
    inferences.push({
      kind: "approximate_experience_years",
      value: merged.reduce((total, interval) => total + interval.end - interval.start, 0),
      derivedFromFactIds: merged.flatMap((interval) => interval.facts.map((fact) => fact.id)),
    });
  }
  return inferences;
}

type ResumeSection = "skills" | "experience" | "projects" | "education" | "certifications";
const sectionNames = new Map<string, ResumeSection>([
  ["skills", "skills"], ["technical skills", "skills"], ["core skills", "skills"], ["key skills", "skills"], ["professional skills", "skills"],
  ["experience", "experience"], ["work experience", "experience"], ["professional experience", "experience"], ["relevant experience", "experience"],
  ["employment", "experience"], ["employment history", "experience"], ["work history", "experience"], ["career history", "experience"], ["professional history", "experience"],
  ["projects", "projects"], ["selected projects", "projects"], ["key projects", "projects"], ["key development projects", "projects"],
  ["relevant projects", "projects"], ["personal projects", "projects"], ["technical projects", "projects"], ["academic projects", "projects"],
  ["education", "education"],
  ["certifications", "certifications"], ["certificates", "certifications"],
]);
const plainTextBoundaries = new Set([
  "summary", "professional summary", "profile", "objective", "contact", "interests", "hobbies", "awards", "publications", "languages", "references",
  "volunteer experience", "volunteering", "additional information", "personal information", "achievements", "activities",
]);
const skillCategoryLabels = new Set([
  "languages", "programming languages", "frameworks", "libraries", "frameworks and libraries", "libraries and frameworks",
  "databases", "tools", "cloud", "platforms", "technologies", "frontend", "front end", "front-end", "frontend technologies",
  "backend", "back end", "back-end", "backend technologies", "devops", "devops tools", "testing", "testing tools",
  "operating systems", "version control", "build tools", "messaging",
]);
// Standalone lines are ambiguous with real skills, so retain only the historically
// supported, low-ambiguity headings here. The broader set is safe after a colon.
const skillSubheadings = new Set(["languages", "programming languages", "frameworks", "databases", "tools", "cloud", "platforms", "technologies"]);

function extractFacts(text: string): CandidateFact[] {
  const facts: CandidateFact[] = [];
  let section: ResumeSection | undefined;
  let sectionLevel = 0;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const markdownHeading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    const heading = (markdownHeading?.[2] ?? trimmed).replace(/:$/, "").trim().toLowerCase();
    const nextSection = sectionNames.get(heading);
    if (nextSection) { section = nextSection; sectionLevel = markdownHeading?.[1]?.length ?? 0; }
    else if (section === "skills" && skillSubheadings.has(heading)) { /* category label, not a fact */ }
    else if (markdownHeading && section === "skills") section = undefined;
    else if (markdownHeading && section && (sectionLevel === 0 || markdownHeading[1]!.length <= sectionLevel)) section = undefined;
    else if (!markdownHeading && plainTextBoundaries.has(heading)) section = undefined;
    else if (section && trimmed) facts.push(...factsFromLine(section, line, lineStart, Boolean(markdownHeading && markdownHeading[1]!.length > sectionLevel)));
    lineStart += line.length + 1;
  }
  return facts;
}

function factsFromLine(section: ResumeSection, line: string, lineStart: number, isNestedHeading: boolean): CandidateFact[] {
  const withoutPrefix = line.trimStart().replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "");
  if (/^(?:ignore (?:all |any )?(?:previous |prior )?instructions?|do not|don't|never|pretend|claim|add|use)\b/i.test(withoutPrefix)) return [];
  if (/\b(?:did not|was not|is not|expired|lapsed|revoked)\b/i.test(withoutPrefix)) return [];
  if (section === "certifications" && /\b(?:inactive|pending|scheduled|planned|in progress|not yet)\b/i.test(withoutPrefix)) return [];
  if (section === "skills" && /\b(?:no|not|without)\b/i.test(withoutPrefix)) return [];
  const skillLabel = /^([^,:|]{1,30}):\s*/.exec(withoutPrefix);
  const content = section === "skills" && skillLabel && skillCategoryLabels.has(skillLabel[1]!.trim().toLowerCase()) ? withoutPrefix.slice(skillLabel[0].length) : withoutPrefix;
  const dateRange = /\b(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+)?(?:19|20)\d{2}\s*(?:—|–|-|to)\s*(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+)?(?:(?:19|20)\d{2}|present|current)\b/i.exec(content);
  const dateFacts = section === "experience" && dateRange ? [factFromValue("date", dateRange[0], line, lineStart)] : [];
  const roleContent = dateRange ? content.slice(0, dateRange.index).trimEnd() : content;
  const roleSeparator = /\s+(?:—|–|-|\bat\b|\|)\s+/i.exec(roleContent);
  const looksLikeRole = /\b(?:engineer|developer|architect|manager|analyst|scientist|designer|consultant|specialist|administrator|lead|director|intern)\b/i.test(roleContent);
  const standaloneRoleWords = roleContent.trim().split(/\s+/);
  const standaloneRole = standaloneRoleWords.length <= 7
    && standaloneRoleWords.every((word) => /^(?:of|and|&)$/i.test(word) || /^[A-Z][A-Za-z0-9+.#/-]*$/.test(word))
    && /\b(?:engineer|developer|architect|manager|analyst|scientist|designer|consultant|specialist|administrator|lead|director|intern)$/i.test(roleContent.trim());
  if (section === "experience" && (isNestedHeading || standaloneRole || (roleSeparator && looksLikeRole))) {
    if (roleSeparator) return [
      ...optionalFact("role", roleContent.slice(0, roleSeparator.index).trim(), line, lineStart),
      ...optionalFact("employer", roleContent.slice(roleSeparator.index + roleSeparator[0].length).trim(), line, lineStart),
      ...dateFacts,
    ];
    return [factFromValue("role", roleContent, line, lineStart), ...dateFacts];
  }
  if (section === "projects" && isNestedHeading) return [factFromValue("project", content, line, lineStart)];
  if (dateFacts.length) return dateFacts;
  const measurable = /(?:\b\d+(?:\.\d+)?%|[$€£]\s?\d|\b\d+(?:\.\d+)?x\b|\b\d+\s?(?:ms|seconds?|minutes?|hours?|users?|requests?|transactions?)\b)/i.test(content);
  if (section === "experience") return [factFromValue(measurable ? "outcome" : "experience_statement", content, line, lineStart)];
  if (section === "projects") return [factFromValue(measurable ? "outcome" : "project_statement", content, line, lineStart)];
  if (section === "education") return [factFromValue("education", content, line, lineStart)];
  if (section === "certifications") return [factFromValue("certification", content, line, lineStart)];
  const values = content.split(/[,;|]/).map((value) => value.trim()).filter(Boolean);
  const kind: CandidateFactKind = "skill";
  let searchFrom = 0;
  return values.flatMap((value) => {
    const relativeStart = line.indexOf(value, searchFrom);
    if (relativeStart < 0) return [];
    searchFrom = relativeStart + value.length;
    const start = lineStart + relativeStart;
    const end = start + value.length;
    return [{ id: `fact_${kind}_${start}_${end}`, kind, value, evidence: [{ start, end, quote: value }] }];
  });
}

function factFromValue(kind: CandidateFactKind, value: string, line: string, lineStart: number): CandidateFact {
  const relativeStart = line.indexOf(value);
  const start = lineStart + relativeStart;
  const end = start + value.length;
  return { id: `fact_${kind}_${start}_${end}`, kind, value, evidence: [{ start, end, quote: value }] };
}

function optionalFact(kind: CandidateFactKind, value: string, line: string, lineStart: number): CandidateFact[] {
  return value ? [factFromValue(kind, value, line, lineStart)] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function normalizeResumeText(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}
