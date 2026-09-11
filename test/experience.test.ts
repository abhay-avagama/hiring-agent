import { expect, test } from "bun:test";
import { experienceLabel, statedExperience, titleExperience } from "../src/experience.ts";

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
    ["", null],
  ];
  for (const [text, expected] of cases) expect([text, statedExperience(text)]).toEqual([text, expected]);
});

test("entry-level titles estimate and labels read naturally", () => {
  expect(titleExperience("Graduate Engineer Trainee")).toEqual({ min: 0, max: 1 });
  expect(titleExperience("Senior Java Engineer")).toBeUndefined();
  expect([experienceLabel({ min: 2, max: 5 }), experienceLabel({ min: 5 })]).toEqual(["2–5 yrs", "5+ yrs"]);
});
