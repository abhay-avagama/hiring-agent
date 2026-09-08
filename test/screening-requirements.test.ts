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

test("WHAT'S REQUIRED HTML headings make following degree and experience bullets mandatory", () => {
  const profile = parseCandidateProfile({ content: "Experience\nEngineer — Acme\nJan 2022 - Dec 2025\nEducation\nBachelor of Arts", format: "text" });
  const requirements = job("<p>WHAT’S REQUIRED<br>• Bachelor’s degree in computer science or another technical field<br>• Minimum 8 years object-oriented programming experience with C#/.NET</p>");
  expect(evaluateScreeningRequirements(profile, requirements)).toEqual([
    expect.objectContaining({ kind: "experience", status: "partial" }),
    expect.objectContaining({ kind: "education", status: "unsupported" }),
  ]);
});

test("Essentials headings make minimum experience requirements mandatory", () => {
  const profile = parseCandidateProfile({ content: "Experience\nSoftware Engineer — Acme\nJan 2022 - Dec 2025", format: "text" });
  expect(evaluateScreeningRequirements(profile, job("<p><strong>Essentials</strong></p><p>10+ years of experience in low level system testing and integration.</p>"))).toEqual([
    expect.objectContaining({ kind: "experience", status: "partial" }),
  ]);
});

function job(description: string): Job {
  return { id: "job", company: "Acme", title: "Principal Engineer", location: "India", remote: false, workMode: "onsite", eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test", description };
}

test("named disciplines are a hard education bar even when the posting adds 'or a related technical discipline'", () => {
  const requirement = job("Requirements\nRequired qualification: Polymer Science, Polymer Technology, Chemistry, Materials Science, or a related technical discipline. 5+ years in product management.");
  const softwarePm = parseCandidateProfile({ content: "Experience\nProduct Manager — Acme\nJan 2018 - Dec 2024\nEducation\nB.Tech in Computer Science", format: "text" });
  const education = evaluateScreeningRequirements(softwarePm, requirement).filter((item) => item.kind === "education");
  expect(education).toHaveLength(1);
  expect(education[0]?.status).toBe("unsupported");
  const chemist = parseCandidateProfile({ content: "Experience\nProduct Manager — Acme\nJan 2018 - Dec 2024\nEducation\nM.Sc in Polymer Chemistry", format: "text" });
  expect(evaluateScreeningRequirements(chemist, requirement).filter((item) => item.kind === "education")[0]?.status).toBe("supported");
});
