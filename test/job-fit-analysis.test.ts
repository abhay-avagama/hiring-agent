import { expect, test } from "bun:test";
import { createJobFitAnalyzer } from "../src/job-fit-analysis.ts";
import type { Job } from "../src/types.ts";

test("selected-job analysis separates explicit evidence, unsupported requirements, risks, and preparation gaps", async () => {
  const job = makeJob({ description: "Java and AWS are required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id,
    resume: { content: "Skills\nJava\nExperience\nBackend Engineer — Acme", format: "text" },
    intent: { roles: ["backend engineer"], countries: ["IN"] },
  });

  expect(result.supported).toEqual([{ requirement: "Java", factIds: [expect.stringContaining("fact_skill_")] }]);
  expect(result.partiallySupported).toEqual([]);
  expect(result.unsupported).toEqual(["AWS"]);
  expect(result.scores).toEqual({ evidence: expect.any(Number), keyword: expect.any(Number) });
  expect(result.screeningRisks).toContain("No explicit or transferable resume evidence supports required skill: AWS");
  expect(result.interviewPreparationGaps).toEqual(["Prepare a truthful response about the unsupported AWS requirement; do not add it to the resume as experience"]);
  expect(result.assessment).toEqual(expect.objectContaining({ fit: "good", reasons: expect.arrayContaining([expect.objectContaining({ claim: "title matches explicit role intent", jobEvidence: expect.objectContaining({ field: "title" }) })]) }));
});

test("assessment reasons do not repeat a seniority mismatch emitted by two analysis stages", async () => {
  const job = makeJob({ title: "Staff Backend Engineer", description: "Java is required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id,
    resume: { content: "Experience\nSenior Backend Engineer — Acme\nSkills\nJava", format: "text" },
    intent: { seniority: ["senior"] },
  });
  const claims = result.assessment.reasons.map((reason) => reason.claim);
  expect(claims.filter((claim) => claim === "seniority differs from explicit intent: staff")).toHaveLength(1);
  expect(new Set(claims).size).toBe(claims.length);
  expect(result.assessment.reasons.find((reason) => reason.claim === "seniority differs from explicit intent: staff")).toEqual(expect.objectContaining({
    candidateFactIds: [expect.stringContaining("fact_role_")],
    jobEvidence: { field: "title", quote: job.title, start: 0, end: job.title.length },
  }));
});

test("unreviewed language similarity remains unsupported and explicit eligibility conflicts force poor fit", async () => {
  const job = makeJob({ description: "Java and AWS are required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id, resume: { content: "Skills\nPython", format: "text" }, intent: { countries: ["US"], roles: ["backend engineer"] },
  });
  expect(result.supported).toEqual([]);
  expect(result.partiallySupported).toEqual([]);
  expect(result.unsupported).toEqual(["Java", "AWS"]);
  expect(result.screeningRisks).toContain("Job is not eligible for requested country: US");
  expect(result.assessment.fit).toBe("poor");
});

test("invalid fit input fails before job lookup and an unknown stable id is distinguishable", async () => {
  let lookups = 0;
  const analyzer = createJobFitAnalyzer({ getJob: async () => { lookups += 1; return null; } });
  for (const input of [null, {}, { jobId: "", resume: { content: "Skills\nJava", format: "text" } }, { jobId: "job", resume: { content: "x", format: "text", path: "/tmp/x" } }]) {
    await expect(analyzer.analyze(input as never)).rejects.toEqual(expect.objectContaining({ code: "invalid_job_fit_input" }));
  }
  expect(lookups).toBe(0);
  await expect(analyzer.analyze({ jobId: "missing", resume: { content: "Skills\nJava", format: "text" } })).rejects.toEqual(expect.objectContaining({ code: "job_not_found", field: "jobId" }));
  expect(lookups).toBe(1);
});

test("experience, education, and authorization requirements remain evidence-grounded", async () => {
  const job = makeJob({ description: "5+ years experience required. Bachelor's degree required. Candidates must be authorized to work in India." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id,
    resume: { content: "Experience\nBackend Engineer — Acme\nJan 2020 - Dec 2024\nEducation\nB.Tech, Pune University", format: "text" },
    intent: { countries: ["IN"] },
  });
  expect(result.supported).toContainEqual(expect.objectContaining({ requirement: "Bachelor's degree", factIds: [expect.stringContaining("fact_education_")] }));
  expect(result.partiallySupported).toContainEqual(expect.objectContaining({ requirement: "5+ years experience", via: "experience_below_requirement", factIds: [expect.stringContaining("fact_date_")] }));
  expect(result.unsupported).toContain("Work authorization in India");
  expect(result.screeningRisks).toContain("Work authorization is required but cannot be inferred from resume silence or geographic intent: India");
});

test("a required certification is supported only by explicit credential evidence", async () => {
  const job = makeJob({ description: "AWS certification is required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id, resume: { content: "Certifications\nAWS Certified Developer", format: "text" },
  });
  expect(result.supported).toEqual([{ requirement: "AWS certification", factIds: [expect.stringContaining("fact_certification_")] }]);
  expect(result.unsupported).toEqual([]);
});

test("a certification never implies hands-on skill evidence", async () => {
  const job = makeJob({ description: "AWS experience is required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id, resume: { content: "Certifications\nAWS Certified Developer", format: "text" },
  });
  expect(result.supported).toEqual([]);
  expect(result.partiallySupported).toEqual([]);
  expect(result.unsupported).toEqual(["AWS"]);
});

test("explicit requirements outside the skill vocabulary remain visible as gaps", async () => {
  const job = makeJob({ description: "Experience with REST APIs and distributed systems is required. Strong communication skills are required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({ jobId: job.id, resume: { content: "Skills\nJava", format: "text" } });
  expect(result.unsupported).toEqual(expect.arrayContaining(["REST APIs", "Distributed systems", "Strong communication skills"]));
  expect(result.assessment.fit).not.toBe("strong");
  for (const reason of result.assessment.reasons) {
    expect(reason.jobEvidence.quote.length).toBeGreaterThan(0);
    for (const factId of reason.candidateFactIds ?? []) expect(result.profile.facts.some((fact) => fact.id === factId)).toBe(true);
  }
});

test("resume-derived title fit and hard-filter risks carry accurate provenance", async () => {
  const job = makeJob({ title: "Backend Engineer", location: "Bengaluru, India", workMode: "onsite", description: "Java is required." });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id,
    resume: { content: "Experience\nBackend Engineer — Acme\nSkills\nJava", format: "text" },
    intent: { locations: ["Pune"], remote: true },
  });
  const titleReason = result.assessment.reasons.find((reason) => reason.claim === "title aligns with resume role evidence");
  expect(titleReason?.candidateFactIds?.length).toBeGreaterThan(0);
  expect(titleReason?.jobEvidence).toEqual(expect.objectContaining({ field: "title", quote: job.title }));
  expect(result.assessment.reasons.find((reason) => reason.claim.includes("location does not match"))?.jobEvidence).toEqual({ field: "location", quote: job.location });
  expect(result.assessment.reasons.find((reason) => reason.claim.includes("not explicitly remote"))?.jobEvidence).toEqual({ field: "workMode", quote: "onsite" });
});

test("OneTrust-style degree and eight-year requirements force a poor fit when the resume falls short", async () => {
  const job = makeJob({
    title: "Principal Software Engineer - Java Backend",
    description: "Requirements\nBachelor’s or master’s degree in computer science, Engineering, or related technical or business field. 8+ years of professional software engineering/development experience. Java, Python, and Angular are required.",
  });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({
    jobId: job.id,
    resume: { content: "Skills\nJava, Python, Angular\nExperience\nStaff Software Engineer — Acme\nJan 2023 - Dec 2026\nEducation\nBachelor of Arts — Siliguri College", format: "text" },
    intent: { roles: ["backend engineer"], countries: ["IN"] },
  });

  expect(result.assessment.fit).toBe("poor");
  expect(result.partiallySupported).toContainEqual(expect.objectContaining({ requirement: "8+ years of professional software engineering/development experience", via: "experience_below_requirement" }));
  expect(result.unsupported).toContain("Bachelor’s or master’s degree in computer science, Engineering, or related technical or business field");
  expect(result.screeningRisks).toEqual(expect.arrayContaining([
    expect.stringContaining("8+ years"),
    expect.stringContaining("Bachelor’s or master’s degree"),
  ]));
});

test("preferred qualification sections never force a poor fit", async () => {
  const job = makeJob({ description: "Java and Python are required.\nBachelor's degree is not required.\nPreferred Qualifications\n8+ years of experience\nBachelor’s degree in computer science" });
  const analyzer = createJobFitAnalyzer({ getJob: async () => job });
  const result = await analyzer.analyze({ jobId: job.id, resume: { content: "Skills\nJava, Python", format: "text" }, intent: { roles: ["backend engineer"] } });
  expect(result.assessment.fit).toBe("strong");
  expect(result.unsupported).toEqual([]);
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "greenhouse:acme:1", company: "Acme", title: "Backend Engineer", location: "Bengaluru, India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.test/1",
    description: "", ...overrides,
  };
}
