import { plainText } from "./providers.ts";

/** Years of experience a posting asks for, read from its own text. */
export interface Experience { min: number; max?: number; maxOpen?: boolean }
export const EXPERIENCE_VERSION = 2;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
const NUM = String.raw`(\d{1,2}(?:\.\d)?|${Object.keys(WORDS).join("|")})`;
const RANGE = String.raw`(?<![\d.])${NUM}\s*\+?\s*(?:(?:-|–|—|to)\s*${NUM}\s*)?\+?\s*(?:years?|yrs?)\+?(?:['’]s?)?`;
// "5+ years of hands-on Java experience" or "Experience: 2-5 years" / "Years of experience 6 to 8 years".
const YEARS_THEN_EXPERIENCE = new RegExp(String.raw`${RANGE}(?:\s+of)?(?:\s+[\w/&,'’()-]+){0,10}?\s+(?:experiences?|exp)\b`, "gi");
const EXPERIENCE_THEN_YEARS = new RegExp(String.raw`\b(?:experiences?|exp)\b[^.\n\d]{0,30}?${RANGE}`, "gi");
// "minimum 15+ years" with no word "experience" after it.
const MINIMUM_YEARS = new RegExp(String.raw`\b(?:minimum|min\.?|at least|atleast)\s*(?:of\s*)?${RANGE}`, "gi");
const STANDALONE_YEARS = new RegExp(String.raw`^[ \t]*(?:[•·-][ \t]*)?${RANGE}[ \t]*[.!]?[ \t]*$`, "gmi");
// Company history reads the same way ("our 135 years of experience"); skip matches that talk about the employer.
const ABOUT_EMPLOYER = /\b(?:our (?:company|firm|group|organi[sz]ation|brands?|history|legacy)|(?:company|firm|group) (?:has|with)|founded|established|history|legacy|heritage)\b[^.\n?!:;•·-]*$/i;
const MIN_PREFIX = /\b(?:minimum|min\.?|at least|atleast)\s*(?:of\s*)?$/i;

function value(text: string | undefined): number | undefined {
  if (!text) return undefined;
  return WORDS[text.toLowerCase()] ?? Number(text);
}

/** Prefer overall/total experience and standalone role ranges to skill-specific requirements. */
export function statedExperience(description: string): Experience | null {
  return readExperience(description)?.experience ?? null;
}

export function readExperience(description: string): { index: number; quote: string; priority: number; experience: Experience } | null {
  const text = plainText(description);
  const found: Array<{ index: number; quote: string; priority: number; experience: Experience }> = [];
  for (const pattern of [YEARS_THEN_EXPERIENCE, EXPERIENCE_THEN_YEARS, MINIMUM_YEARS, STANDALONE_YEARS]) {
    for (const match of text.matchAll(pattern)) {
      const [low, high] = [value(match[1]), value(match[2])];
      if (low === undefined || !Number.isFinite(low)) continue;
      // Requirements rarely pass 20 years; bigger numbers are nearly always an employer's history.
      if (low > 20 || (high !== undefined && (high < low || high > 40))) continue;
      const before = text.slice(Math.max(0, match.index - 60), match.index);
      if (pattern !== MINIMUM_YEARS && ABOUT_EMPLOYER.test(before) && !MIN_PREFIX.test(before)) continue;
      const lineStart = Math.max(text.lastIndexOf("\n", match.index - 1), text.lastIndexOf(".", match.index - 1)) + 1;
      const context = text.slice(lineStart, match.index) + match[0];
      const priority = /\b(?:overall|total)\b/i.test(context) ? 3 : pattern === STANDALONE_YEARS ? 2 : 1;
      const maxOpen = high !== undefined && /(?:\+\s*(?:years?|yrs?)|(?:years?|yrs?)\s*\+)/i.test(match[0]);
      found.push({ index: match.index, quote: match[0], priority, experience: high !== undefined && high !== low ? { min: low, max: high, ...(maxOpen ? { maxOpen: true } : {}) } : { min: low } });
    }
  }
  found.sort((left, right) => right.priority - left.priority || right.experience.min - left.experience.min || left.index - right.index);
  return found[0] ?? null;
}

/** Entry-level titles (intern, trainee, fresher, graduate) as a rough 0–1 year estimate when the posting states nothing. */
export function titleExperience(title: string): Experience | undefined {
  return /\b(?:intern|internship|trainee|freshers?|graduate|apprentice(?:ship)?|entry[- ]level)\b/i.test(title) ? { min: 0, max: 1 } : undefined;
}

/** "2–5 yrs", "5+ yrs". */
export function experienceLabel(experience: Experience): string {
  return experience.max === undefined ? `${experience.min}+ yrs` : `${experience.min}–${experience.max}${experience.maxOpen ? "+" : ""} yrs`;
}

export function experienceMatches(experience: Experience, years: number): boolean {
  return years >= experience.min && (experience.max === undefined || experience.maxOpen === true || years <= experience.max);
}

/** Old cached readings without their source text cannot be safely corrected: make them unknown. */
export function normalizeJobExperience<T extends { description: string; experience?: Experience | null; experienceVersion?: number }>(job: T): Omit<T, "experience" | "experienceVersion"> & { experience?: Experience | null; experienceVersion?: number } {
  if (job.description.trim()) return { ...job, experience: statedExperience(job.description), experienceVersion: EXPERIENCE_VERSION };
  if (job.experienceVersion === EXPERIENCE_VERSION) return job;
  const { experience: _experience, experienceVersion: _version, ...rest } = job;
  return rest;
}
