import { expect, test } from "bun:test";
import { matchJobs } from "../src/job-matching.ts";
import { parseCandidateProfile } from "../src/candidate-profile.ts";
import type { Job } from "../src/types.ts";

test("requested country is a hard filter and stronger evidenced matches rank first", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, PostgreSQL\nExperience\nSenior Backend Engineer — Acme\nJan 2020 - Dec 2024", format: "text" });
  const jobs = [
    job({ id: "weak", title: "Backend Engineer", description: "Ruby is required.", eligibleCountries: ["IN"] }),
    job({ id: "outside", title: "Senior Java Engineer", description: "Java and PostgreSQL are required.", eligibleCountries: ["US"] }),
    job({ id: "strong", title: "Senior Backend Engineer", description: "Java and PostgreSQL are required.", eligibleCountries: ["IN"] }),
  ];

  const result = matchJobs(profile, { countries: ["IN"], roles: ["backend engineer"] }, jobs);

  expect(result.matches.map((match) => match.job.id)).toEqual(["strong", "weak"]);
  expect(result.filteredOut).toEqual([{ jobId: "outside", reasons: ["country_not_eligible:IN"] }]);
  expect(result.matches[0]).toEqual(expect.objectContaining({
    fit: "strong",
    supported: expect.arrayContaining([
      expect.objectContaining({ requirement: "Java", factIds: [expect.stringContaining("fact_skill_")] }),
      expect.objectContaining({ requirement: "PostgreSQL", factIds: [expect.stringContaining("fact_skill_")] }),
    ]),
  }));
});

test("explicit location, work-mode, and exclusion intent are hard filters", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const jobs = [
    job({ id: "keep", title: "Java Engineer", location: "Bangalore, India", workMode: "remote", remote: true }),
    job({ id: "onsite", title: "Java Engineer", workMode: "onsite", remote: false }),
    job({ id: "wrong-city", title: "Java Engineer", location: "Pune, India", workMode: "remote", remote: true }),
    job({ id: "excluded", title: "Contract Java Engineer", location: "Bengaluru, India", workMode: "remote", remote: true }),
  ];

  const result = matchJobs(profile, { countries: ["IN"], locations: ["Bengaluru"], remote: true, excludedTerms: ["contract"] }, jobs);

  expect(result.matches.map((match) => match.job.id)).toEqual(["keep"]);
  expect(result.filteredOut).toEqual([
    { jobId: "onsite", reasons: ["remote_required"] },
    { jobId: "wrong-city", reasons: ["location_mismatch"] },
    { jobId: "excluded", reasons: ["excluded_term:contract"] },
  ]);
});

test("non-remote intent rejects remote and unknown work modes", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, { remote: false }, [
    job({ id: "onsite", workMode: "onsite", remote: false }),
    job({ id: "hybrid", workMode: "hybrid", remote: false }),
    job({ id: "remote", workMode: "remote", remote: true }),
    job({ id: "unknown", workMode: "unknown", remote: false }),
  ]);
  expect(result.matches.map((match) => match.job.id)).toEqual(["onsite", "hybrid"]);
  expect(result.filteredOut).toEqual([
    { jobId: "remote", reasons: ["non_remote_required"] },
    { jobId: "unknown", reasons: ["non_remote_required"] },
  ]);
});

test("structured country, location, and role exclusions are hard filters", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, { excludedCountries: ["US"], excludedLocations: ["Pune"], excludedRoles: ["manager"] }, [
    job({ id: "country", eligibleCountries: ["US"], location: "New York, US" }),
    job({ id: "location", location: "Pune, India" }),
    job({ id: "role", title: "Engineering Manager" }),
    job({ id: "keep", title: "Java Engineer" }),
  ]);
  expect(result.matches.map((match) => match.job.id)).toEqual(["keep"]);
  expect(result.filteredOut).toEqual([
    { jobId: "country", reasons: ["country_excluded:US"] },
    { jobId: "location", reasons: ["location_excluded:Pune"] },
    { jobId: "role", reasons: ["role_excluded:manager"] },
  ]);
});

test("multi-token role exclusions do not reject a nearby but distinct role", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, { excludedRoles: ["backend engineering manager"] }, [
    job({ id: "exclude", title: "Senior Backend Engineering Manager" }),
    job({ id: "keep", title: "Product Manager" }),
  ]);
  expect(result.matches.map((match) => match.job.id)).toEqual(["keep"]);
  expect(result.filteredOut).toEqual([{ jobId: "exclude", reasons: ["role_excluded:backend engineering manager"] }]);
});

test("transferable evidence stays separate from explicit support and missing skills remain gaps", () => {
  const profile = parseCandidateProfile({ content: "Skills\nPython", format: "text" });
  const result = matchJobs(profile, { roles: ["backend engineer"] }, [
    job({ id: "java", title: "Backend Engineer", description: "Required: Java and Kubernetes." }),
  ]);

  expect(result.matches[0]).toEqual(expect.objectContaining({
    supported: [],
    transferable: [{ requirement: "Java", via: "backend_programming", factIds: [profile.facts[0]!.id] }],
    gaps: ["Kubernetes"],
  }));
  expect(result.matches[0]!.reasons).toContain("Java has related backend_programming evidence but is not an explicit resume skill");
});

test("explicit seniority intent overrides resume inference and skill matching uses whole terms", () => {
  const profile = parseCandidateProfile({ content: "Skills\nGo\nExperience\nSenior Engineer — Acme", format: "text" });
  const result = matchJobs(profile, { roles: ["engineer"], seniority: ["junior"] }, [
    job({ id: "senior", title: "Senior Engineer", description: "Good communication is required." }),
    job({ id: "junior", title: "Junior Engineer", description: "Learn backend systems." }),
  ]);

  expect(result.matches.map((match) => match.job.id)).toEqual(["junior", "senior"]);
  expect(result.matches[0]!.reasons).toContain("seniority matches explicit intent: junior");
  expect(result.matches[1]!.supported).toEqual([]);
  expect(result.matches[1]!.gaps).toEqual([]);
});

test("manager intent takes precedence for compound managerial titles", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, { seniority: ["manager"] }, [job({ title: "Senior Engineering Manager" })]);
  expect(result.matches[0]!.reasons).toContain("seniority matches explicit intent: manager");
});

test("resume role-family evidence guides ordering unless explicit role intent overrides it", () => {
  const profile = parseCandidateProfile({ content: "Skills\nPython", format: "text" });
  const jobs = [
    job({ id: "frontend", title: "Frontend Engineer", description: "Python tooling is useful." }),
    job({ id: "backend", title: "Backend Engineer", description: "Python services." }),
  ];

  expect(matchJobs(profile, {}, jobs).matches.map((match) => match.job.id)).toEqual(["backend", "frontend"]);
  const explicit = matchJobs(profile, { roles: ["frontend engineer"] }, jobs);
  expect(explicit.matches.map((match) => match.job.id)).toEqual(["frontend", "backend"]);
  expect(explicit.matches[0]!.reasons).toContain("title matches explicit role intent");
});

test("only requirement-shaped skill mentions become gaps", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, {}, [job({ description: "Kubernetes is nice to know. AWS is required." })]);
  expect(result.matches[0]!.gaps).toEqual(["AWS"]);
});

test("optional and negated skill mentions are neither supported requirements nor gaps", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, Kubernetes", format: "text" });
  for (const description of ["Java is optional.", "Java is not required.", "No Kubernetes experience needed.", "We are migrating away from Java."]) {
    const match = matchJobs(profile, {}, [job({ description })]).matches[0]!;
    expect(match.supported).toEqual([]);
    expect(match.gaps).toEqual([]);
  }


  const mixed = matchJobs(profile, {}, [job({ description: "Java is required, while AWS is preferred; Kubernetes is not required." })]).matches[0]!;
  expect(mixed.supported.map((item) => item.requirement)).toEqual(["Java"]);
  expect(mixed.gaps).toEqual([]);

  for (const description of ["Java is required and Kubernetes is optional.", "Java required and AWS not required."]) {
    const coordinated = matchJobs(profile, {}, [job({ description })]).matches[0]!;
    expect(coordinated.supported.map((item) => item.requirement)).toEqual(["Java"]);
    expect(coordinated.gaps).toEqual([]);
  }

  const sharedQualifier = matchJobs(profile, {}, [job({ description: "Java and Python are required and Kubernetes is optional." })]).matches[0]!;
  expect(sharedQualifier.supported.map((item) => item.requirement)).toEqual(["Java"]);
  expect(sharedQualifier.transferable.map((item) => item.requirement)).toEqual(["Python"]);
  expect(sharedQualifier.gaps).toEqual([]);
});

test("required skill intent guides ordering without manufacturing resume support", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, { requiredSkills: ["Kubernetes"] }, [
    job({ id: "plain", description: "Build reliable services." }),
    job({ id: "focused", description: "Operate services on Kubernetes." }),
  ]);

  expect(result.matches.map((match) => match.job.id)).toEqual(["focused", "plain"]);
  expect(result.matches[0]!.supported).toEqual([]);
  expect(result.matches[0]!.gaps).toEqual(["Kubernetes"]);
  expect(result.matches[0]!.reasons).toContain("job matches requested skill focus: Kubernetes");
});

test("requested skill focus already evidenced by the resume is never reported as a gap", () => {
  const profile = parseCandidateProfile({ content: "Skills\nKubernetes", format: "text" });
  const match = matchJobs(profile, { requiredSkills: ["Kubernetes"] }, [job({ description: "Our platform runs on Kubernetes." })]).matches[0]!;
  expect(match.gaps).toEqual([]);
  expect(match.supported).toEqual([]);
  expect(match.reasons).toContain("job matches requested skill focus: Kubernetes");
});

test("duplicate skill intent does not inflate fit and unresolved must-haves prevent strong fit", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, PostgreSQL", format: "text" });
  const focused = matchJobs(profile, { requiredSkills: ["Kubernetes", "kubernetes"] }, [job({ description: "Kubernetes is used by the team." })]).matches[0]!;
  expect(focused.fit).toBe("stretch");

  const withGap = matchJobs(profile, { roles: ["backend engineer"] }, [job({ title: "Backend Engineer", description: "Java, PostgreSQL, and AWS are required." })]).matches[0]!;
  expect(withGap.fit).toBe("good");
  expect(withGap.gaps).toEqual(["AWS"]);
});

test("ties use freshness then input order, and missing intent is surfaced", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const jobs = [
    job({ id: "older", updatedAt: "2026-01-01T00:00:00Z" }),
    job({ id: "newer-first", updatedAt: "2026-02-01T00:00:00Z" }),
    job({ id: "newer-second", updatedAt: "2026-02-01T00:00:00Z" }),
  ];
  const result = matchJobs(profile, {}, jobs, 2);

  expect(result.matches.map((match) => match.job.id)).toEqual(["newer-first", "newer-second"]);
  expect(result.matches[0]!.reasons).toEqual(["no direct resume evidence matched; retained as a stretch option"]);
  expect(result.assumptions).toEqual([
    "No positive target country was requested",
    "No explicit role intent was supplied; resume role evidence guided ordering",
    "No work-mode preference was requested",
  ]);
});

test("repeated resume keywords never count as repeated competence evidence", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava\nJava", format: "text" });
  const result = matchJobs(profile, {}, [job({ title: "Engineer", description: "Java is required." })]);

  expect(result.matches[0]!.supported).toEqual([{ requirement: "Java", factIds: profile.facts.map((fact) => fact.id) }]);
  expect(result.matches[0]!.fit).toBe("stretch");
});

test("matching rejects a candidate profile whose evidence has been tampered with", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  profile.facts[0]!.evidence[0]!.quote = "Rust";
  expect(() => matchJobs(profile, {}, [job({ description: "Java is required." })])).toThrow("invalid_candidate_profile");
});

test("mandatory experience and degree shortfalls demote an otherwise strong principal match", () => {
  const profile = parseCandidateProfile({
    content: "Skills\nJava, Python, Angular\nExperience\nStaff Software Engineer — Acme\nJan 2023 - Dec 2026\nEducation\nBachelor of Arts — Siliguri College",
    format: "text",
  });
  const result = matchJobs(profile, { roles: ["backend engineer"], countries: ["IN"] }, [
    job({ id: "principal", title: "Principal Software Engineer - Java Backend", description: "<h3>Your Experience Includes</h3><p>Bachelor’s or master’s degree in computer science, Engineering, or related technical or business field.<br>8+ years of professional software&nbsp;engineering/development experience<br>Java, Python, and Angular are required.</p>" }),
    job({ id: "senior", title: "Senior Backend Engineer", description: "Java is required." }),
  ]);
  const match = result.matches.find((candidate) => candidate.job.id === "principal")!;

  expect(result.matches[0]!.job.id).toBe("senior");
  expect(match.fit).toBe("stretch");
  expect(match.gaps).toEqual(expect.arrayContaining([
    "8+ years of professional software engineering/development experience",
    "Bachelor’s or master’s degree in computer science, Engineering, or related technical or business field",
  ]));
});

test("preferred qualification sections do not demote an otherwise strong match", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, Python", format: "text" });
  const match = matchJobs(profile, { roles: ["backend engineer"] }, [job({
    title: "Backend Engineer",
    description: "Java and Python are required.\nBachelor's degree is not required.\nPreferred Qualifications\n8+ years of experience\nBachelor’s degree in computer science\nAWS is required.",
  })]).matches[0]!;
  expect(match.fit).toBe("strong");
  expect(match.gaps).toEqual([]);
});

test("explicit backend intent ranks backend and software roles above adjacent specialist titles", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, Python", format: "text" });
  const description = "Java and Python are required.";
  const result = matchJobs(profile, { roles: ["backend engineer"] }, [
    job({ id: "ai", title: "AI/ML - Investment Services", description }),
    job({ id: "qa", title: "QA Automation Engineer", description }),
    job({ id: "support", title: "Support Engineer", description }),
    job({ id: "software", title: "Software Engineer, Technology", description }),
    job({ id: "backend", title: "Backend Engineer III", description }),
    job({ id: "sre", title: "Senior Site Reliability Engineer", description }),
    job({ id: "backend-product", title: "Backend Product Manager", description }),
    job({ id: "backend-qa", title: "Backend QA Engineer", description }),
    job({ id: "software-qa", title: "Software QA Engineer", description }),
  ]);
  expect(result.matches.map((match) => match.job.id)).toEqual([
    "backend", "software", "ai", "qa", "support", "sre", "backend-product", "backend-qa", "software-qa",
  ]);
  expect(result.matches[0]!.reasons).toContain("title matches explicit role intent");
  expect(result.matches[1]!.reasons).toContain("title is adjacent to explicit role intent");
  expect(result.matches.slice(2).every((match) => !match.reasons.some((reason) => reason.includes("role intent")))).toBe(true);
});

test("mixed explicit role targets retain exact matches outside the backend family", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava", format: "text" });
  const result = matchJobs(profile, { roles: ["backend engineer", "data engineer"] }, [
    job({ id: "data", title: "Data Engineer" }),
    job({ id: "qa", title: "Backend QA Engineer" }),
  ]);
  expect(result.matches.map((match) => match.job.id)).toEqual(["data", "qa"]);
  expect(result.matches[0]!.reasons).toContain("title matches explicit role intent");
  expect(result.matches[1]!.reasons).not.toContain("title matches explicit role intent");
});

test("required HTML sections expose material domain and platform gaps instead of producing a false strong fit", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, Python, SQL\nExperience\nBackend Engineer — Acme\nBuilt REST APIs with Java", format: "text" });
  const description = [
    "<p><strong>WHAT'S REQUIRED</strong></p>",
    "<ul>",
    "<li>2–8 years of professional software development experience with solid experience with Java and Java-based technologies.</li>",
    "<li>Solid knowledge of financial products including fixed income, credit, equities, and derivatives.</li>",
    "<li>Experience in SQL development and building large-scale data warehouses.</li>",
    "<li>Proficiency in Python and hands-on experience with Databricks for ETL pipeline development.</li>",
    "<li>Experience with high volume messaging architectures, streaming platforms, and transaction processing systems.</li>",
    "<li>Hands-on experience developing microservices on Kubernetes-based platforms and AWS infrastructure.</li>",
    "</ul>",
    "<p><strong>WE TAKE CARE OF OUR PEOPLE</strong></p>",
    "<li>Health care benefits</li>",
  ].join("\n");

  const match = matchJobs(profile, { roles: ["backend engineer"] }, [job({ title: "Software Engineer, Technology", description })]).matches[0]!;

  expect(match.fit).toBe("stretch");
  expect(match.gaps).toEqual(expect.arrayContaining([
    "Financial products", "Databricks", "ETL pipelines", "High-volume messaging", "Streaming platforms", "Transaction processing", "Kubernetes", "AWS",
  ]));
  expect(match.gaps).not.toContain("Health care");
});

test("credible fit tiers rank ahead of skill-heavy jobs with mandatory screening shortfalls", () => {
  const profile = parseCandidateProfile({ content: "Skills\nJava, Python, SQL, AWS, Docker, React\nExperience\nBackend Engineer — Acme\nJan 2022 - Dec 2025", format: "text" });
  const result = matchJobs(profile, { roles: ["backend engineer"] }, [
    job({ id: "stretch", title: "Backend Engineer", description: "Java, Python, SQL, AWS, Docker, and React are required. Minimum 8 years of professional software engineering experience." }),
    job({ id: "good", title: "Software Engineer", description: "Java is required." }),
  ]);
  expect(result.matches.map((match) => [match.job.id, match.fit])).toEqual([["good", "good"], ["stretch", "stretch"]]);
});

function job(overrides: Partial<Job>): Job {
  return {
    id: "job", company: "Example", title: "Engineer", location: "Bengaluru, India", remote: false, workMode: "onsite",
    eligibleCountries: ["IN"], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "explicit", url: "https://example.com/job",
    description: "", ...overrides,
  };
}
