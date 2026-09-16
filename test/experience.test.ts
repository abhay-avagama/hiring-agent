import { expect, test } from "bun:test";
import { EXPERIENCE_VERSION, experienceLabel, experienceMatches, normalizeJobExperience, statedExperience, titleExperience } from "../src/experience.ts";

test("overall range wins over React-specific minimum, preserving an open upper end", () => {
  const overall = "<p>Java, React JS, Full Stack Development</p><p>5-8&#43; Years</p>";
  const skill = "<p>Minimum of 3 years of experience in React development</p>";
  for (const description of [overall + skill, skill + overall, "3 years of React experience. Total experience: 5-8+ years"]) {
    const experience = statedExperience(description)!;
    expect(experience).toEqual({ min: 5, max: 8, maxOpen: true });
    expect(experienceLabel(experience)).toBe("5–8+ yrs");
    expect(experienceMatches(experience, 3)).toBe(false);
    expect(experienceMatches(experience, 5)).toBe(true);
    expect(experienceMatches(experience, 10)).toBe(true);
  }
  expect(statedExperience("5–8 years")).toEqual({ min: 5, max: 8 });
  expect(experienceMatches({ min: 5, max: 8 }, 10)).toBe(false);
  expect(statedExperience("Minimum 3 years of React experience. Minimum 5 years of development experience.")).toEqual({ min: 5 });
  expect(statedExperience("Age: 5-8 years\nCompany established 8 years ago")).toBeNull();
});

test("outdated cached experience is recomputed or unknown, never silently reused", () => {
  expect(normalizeJobExperience({ description: "5-8+ Years", experience: { min: 3 } })).toEqual({ description: "5-8+ Years", experience: { min: 5, max: 8, maxOpen: true }, experienceVersion: EXPERIENCE_VERSION });
  expect(normalizeJobExperience({ description: "", experience: { min: 3 } })).toEqual({ description: "" });
  expect(normalizeJobExperience({ description: "", experience: { min: 5 }, experienceVersion: EXPERIENCE_VERSION }).experience).toEqual({ min: 5 });
});

test("reads the years a posting asks for and ignores employer history", () => {
  const cases: Array<[string, ReturnType<typeof statedExperience>]> = [
    ["Beginner proficiency in adaptability.  Experience: 0-2 years  Educational qualification: Any Graduate", { min: 0, max: 2 }],
    ["Qualification Bachelor of Commerce \nYears Of Experience 6 to 8 years \n", { min: 6, max: 8 }],
    ["What are we looking for? - 8 to 10 years of sales and/or marketing experience is required", { min: 8, max: 10 }],
    ["Minimum Qualifications 7+ years of experience in wireless", { min: 7 }],
    ["M.Pharm/ M.Sc.). · 2–7 years of experience in Pharma", { min: 2, max: 7 }],
    ["Advertising preferred 0-2 years' experience in a fast-paced agency", { min: 0, max: 2 }],
    ["Min. 8-8 years of previous experience in Finance", { min: 8 }],
    ["You bring at least two years of experience with SQL.", { min: 2 }],
    ["worldwide. With more than 135 years of financial experience and over 20,000 staff", null],
    ["Our firm has 15 years of experience serving clients. You have 3+ years of experience in audit.", { min: 3 }],
    ["Candidates aged 21-35 years may apply. No experience needed.", null],
    ["Required Qualifications:\n\n4&#43; years of Software Engineering experience, or equivalent", { min: 4 }],
    ["Minimum 5- 7 years experiences in automation equipment design", { min: 5, max: 7 }],
    ["We are looking for Experienced person (minimum 15+ years) with deep knowledge of repo", { min: 15 }],
    ["Required Qualifications: 4+ years of customer service, loan administration, or equivalent experience", { min: 4 }],
    ["Experience & Qualifications 10 years+ of experience in brand, graphic, or packaging design", { min: 10 }],
    ["Inter CMA/Inter CA/MBA and/or 5+ year’s of costing and accounting experience", { min: 5 }],
    ["Minimum Education BSc/B. Pharma 3 +Yrs of experience.", { min: 3 }],
    ["With 60 years of experience across industries and a vast network", null],
    ["Complementary Health screening for 35 yrs. and above", null],
    ["We are looking for someone with 5+ years of experience in payments.", { min: 5 }],
    ["", null],
  ];
  for (const [text, expected] of cases) expect([text, statedExperience(text)]).toEqual([text, expected]);
});

test("entry-level titles estimate and labels read naturally", () => {
  expect(titleExperience("Graduate Engineer Trainee")).toEqual({ min: 0, max: 1 });
  expect(titleExperience("Senior Java Engineer")).toBeUndefined();
  expect([experienceLabel({ min: 2, max: 5 }), experienceLabel({ min: 5 })]).toEqual(["2–5 yrs", "5+ yrs"]);
});
