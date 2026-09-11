/** Years of experience a posting asks for, read from its own text. */
export interface Experience { min: number; max?: number }

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
const NUM = String.raw`(\d{1,2}(?:\.\d)?|${Object.keys(WORDS).join("|")})`;
const RANGE = String.raw`(?<![\d.])${NUM}\s*\+?\s*(?:(?:-|–|—|to)\s*${NUM}\s*)?\+?\s*(?:years?|yrs?)(?:'|’)?`;
// "5+ years of hands-on Java experience" or "Experience: 2-5 years" / "Years of experience 6 to 8 years".
const YEARS_THEN_EXPERIENCE = new RegExp(String.raw`${RANGE}(?:\s+of)?(?:\s+[\w/&,'’()-]+){0,6}?\s+(?:experience|exp)\b`, "gi");
const EXPERIENCE_THEN_YEARS = new RegExp(String.raw`\b(?:experience|exp)\b[^.\n\d]{0,30}?${RANGE}`, "gi");
// Company history reads the same way ("our 135 years of experience"); skip matches that talk about the employer.
const ABOUT_EMPLOYER = /\b(?:we|our|company|firm|founded|established|history|legacy|heritage)\b[^.\n?!:;•·-]*$/i;
const MIN_PREFIX = /\b(?:minimum|min\.?|at least|atleast)\s*(?:of\s*)?$/i;

function value(text: string | undefined): number | undefined {
  if (!text) return undefined;
  return WORDS[text.toLowerCase()] ?? Number(text);
}

/** The first experience requirement the text states, or null when it states none. */
export function statedExperience(text: string): Experience | null {
  const found: Array<{ index: number; experience: Experience }> = [];
  for (const pattern of [YEARS_THEN_EXPERIENCE, EXPERIENCE_THEN_YEARS]) {
    for (const match of text.matchAll(pattern)) {
      const [low, high] = [value(match[1]), value(match[2])];
      if (low === undefined || !Number.isFinite(low)) continue;
      // Requirements rarely pass 20 years; bigger numbers are nearly always an employer's history.
      if (low > 20 || (high !== undefined && (high < low || high > 40))) continue;
      const before = text.slice(Math.max(0, match.index - 60), match.index);
      if (ABOUT_EMPLOYER.test(before) && !MIN_PREFIX.test(before)) continue;
      found.push({ index: match.index, experience: high !== undefined && high !== low ? { min: low, max: high } : { min: low } });
    }
  }
  found.sort((left, right) => left.index - right.index);
  return found[0]?.experience ?? null;
}

/** Entry-level titles (intern, trainee, fresher, graduate) as a rough 0–1 year estimate when the posting states nothing. */
export function titleExperience(title: string): Experience | undefined {
  return /\b(?:intern|internship|trainee|freshers?|graduate|apprentice(?:ship)?|entry[- ]level)\b/i.test(title) ? { min: 0, max: 1 } : undefined;
}

/** "2–5 yrs", "5+ yrs". */
export function experienceLabel(experience: Experience): string {
  return experience.max === undefined ? `${experience.min}+ yrs` : `${experience.min}–${experience.max} yrs`;
}
