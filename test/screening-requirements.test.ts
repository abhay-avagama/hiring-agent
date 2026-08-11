import { expect, test } from "bun:test";
import { parseCandidateProfile } from "../src/candidate-profile.ts";
import { evaluateScreeningRequirements } from "../src/screening-requirements.ts";
import type { Job } from "../src/types.ts";

test("field-specific degrees and experience minimums use explicit resume evidence", () => {
  const requirement = job("Requirements\nBachelor’s or master’s degree in computer science, Engineering, or related technical or business field. 8+ years of professional software engineering/development experience.");
  const qualified = parseCandidateProfile({ content: "Experience\nEngineer — Acme\nJan 2015 - Dec 2024\nEducation\nB.Tech in Computer Science", format: "text" });
  expect(evaluateScreeningRequirements(qualified, requirement).map((item) => item.status)).toEqual(["supported", "supported"]);

  const artsDegree = parseCandidateProfile({ content: "Experience\nEngineer — Acme\nJan 2020 - Dec 2024\nEducation\nBachelor of Arts", format: "text" });
  expect(evaluateScreeningRequirements(artsDegree, requirement)).toEqual([
    expect.objectContaining({ kind: "experience", status: "partial", factIds: [expect.stringContaining("fact_date_")] }),
    expect.objectContaining({ kind: "education", status: "unsupported", factIds: [] }),
  ]);
});

test("alternative master's degrees qualify while preferred and negated clauses never become gates", () => {
  const masters = parseCandidateProfile({ content: "Education\nM.Tech in Computer Science", format: "text" });
  expect(evaluateScreeningRequirements(masters, job("Qualifications\nBachelor’s or master’s degree in computer science or Engineering."))).toEqual([
    expect.objectContaining({ kind: "education", status: "supported", factIds: [expect.stringContaining("fact_education_")] }),
  ]);

  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  expect(evaluateScreeningRequirements(profile, job("8+ years of experience preferred. Bachelor’s degree in computer science is optional. 10 years of experience not required."))).toEqual([]);
  expect(evaluateScreeningRequirements(profile, job("Preferred Qualifications\n8+ years of experience\nBachelor’s degree in computer science\nOptional Requirements\n10+ years of software engineering experience"))).toEqual([]);
  expect(evaluateScreeningRequirements(profile, job("Bachelor's degree is not required."))).toEqual([]);
});

function job(description: string): Job {
  return { id: "job", company: "Acme", title: "Principal Engineer", location: "India", remote: false, workMode: "onsite", eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test", description };
}
