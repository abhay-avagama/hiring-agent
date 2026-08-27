export const titlePattern = /\b(?:gtm|revops|rev ops|growth engineer|growth automation|marketing engineer)\b/iu;
const exactTitles = new Set(["gtm engineer", "revops engineer"]);

export function normalizeTitle(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

export function isExactEngineerTitle(title: string | undefined): boolean {
  return exactTitles.has(normalizeTitle(title));
}
