import { expect, test } from "bun:test";
import { createInterviewPreparer } from "../src/interview-preparation.ts";
import type { AnalyzeJobFitResult } from "../src/job-fit-analysis.ts";
import type { Job } from "../src/types.ts";

const job = (id: string, title: string, skills: string, location = "Pune, India") => // skills are stored as search tokens
  ({ id: `workday:acme:${id}`, company: "Acme", title, location, description: "", skills, url: "https://acme.example/jobs/" + id }) as unknown as Job;

test("interview preparation pairs the fit evidence with what the employer's own board shows, and asks before anything is claimed", async () => {
  const target = job("1", "Angular Developer", "angular typescript redux cypress");
  const board = [target, job("2", "Senior Angular Engineer", "angular typescript redux"), job("3", "QA Automation Engineer", "cypress typescript selenium", "Bengaluru, India"), job("4", "SAP Consultant", "sap")];
  const analysis = {
    job: target, assessment: { fit: "good", reasons: [] },
    supported: [{ requirement: "Angular", factIds: ["f1"] }], partiallySupported: [{ requirement: "RxJS", via: "related_skill", factIds: ["f2"] }],
    unsupported: ["Cypress"], screeningRisks: ["Degree: B.E. or B.Tech required"], interviewPreparationGaps: [], scores: {}, profile: {},
  } as unknown as AnalyzeJobFitResult;
  let analysed: unknown;
  const preparer = createInterviewPreparer({ analyzeJobFit: async (input) => { analysed = input; return analysis; }, employerJobs: async () => board });
  const result = await preparer.prepare({ jobId: target.id, resume: { content: "Skills\nAngular", format: "text" }, minutes: 45, round: "technical" });

  expect(analysed).toEqual({ jobId: target.id, resume: { content: "Skills\nAngular", format: "text" } });
  expect(result.employer.liveRoles).toBe(4);
  expect(result.employer.skills.slice(0, 3)).toEqual([{ skill: "typescript", roles: 3 }, { skill: "angular", roles: 2 }, { skill: "redux", roles: 2 }]);
  // Roles sharing two or more of this role's skills point at the team; the SAP consultant does not.
  expect(result.employer.relatedRoles.map((role) => role.title)).toEqual(["Senior Angular Engineer", "QA Automation Engineer"]);
  expect(result.fit.screeningRisks).toEqual(["Degree: B.E. or B.Tech required"]);
  expect(result.verifyBeforeClaiming.join("\n")).toContain("Cypress: the resume does not show this");
  expect(result.verifyBeforeClaiming.join("\n")).toContain("RxJS: the resume shows related");
  expect(result.brief.plan.at(-1)!.minutes).toBe("40–45"); // the plan scales to the time the candidate has
  expect(result.brief.sections[0]).toContain("technical round");
  expect(result.brief.rules.join(" ")).toContain("Never invent");
});

test("interview preparation refuses input it does not understand", async () => {
  const preparer = createInterviewPreparer({ analyzeJobFit: async () => { throw new Error("should not run"); }, employerJobs: async () => [] });
  await expect(preparer.prepare({ jobId: "x", resume: { content: "a", format: "text" }, minutes: 5 })).rejects.toThrow("minutes");
  await expect(preparer.prepare({ jobId: "x", resume: { content: "a", format: "text" }, company: "Acme" })).rejects.toThrow();
});

test("a resume skill named differently from the requirement still counts as evidence: Go for Golang, PostgreSQL for SQL", async () => {
  const { matchesExactSkillEvidence } = await import("../src/requirement-vocabulary.ts");
  expect(matchesExactSkillEvidence("golang", "Go")).toBe(true);
  expect(matchesExactSkillEvidence("go", "Golang")).toBe(true);
  expect(matchesExactSkillEvidence("sql", "PostgreSQL")).toBe(true);
  expect(matchesExactSkillEvidence("postgresql", "SQL")).toBe(false); // knowing SQL is not knowing PostgreSQL
});

test("a pasted job description prepares the same way, and finds the employer's board by name when Openings indexes it", async () => {
  const { createHostedRuntime } = await import("../src/runtime.ts");
  const board = [job("1", "Angular Developer", "angular typescript cypress"), job("2", "QA Engineer", "cypress typescript selenium")]
    .map((item) => ({ ...item, id: item.id.replace("workday:acme", "greenhouse:acme") }));
  const store = { read: async () => ({ version: 1 as const, updatedAt: "2026-11-26T00:00:00Z", partitions: { acme: { fetchedAt: "2026-11-26T00:00:00Z", jobs: board } }, lastCrawl: { startedAt: "", finishedAt: "", selected: 0, succeeded: 0, failed: [] } }), write: async () => {} };
  const runtime = createHostedRuntime({ sources: [{ slug: "acme", name: "Acme Technologies Pvt. Ltd.", ats: "greenhouse", token: "acme" }], store });
  const description = "We are hiring an Angular developer with 3+ years of experience in Angular, TypeScript and RxJS. You will build reusable components and data-heavy dashboards, write unit tests and Cypress end-to-end tests, and work with REST APIs. Experience with CI/CD is a plus.";
  const resume = { content: "Experience\nAngular developer, 2021-2026\nSkills\nAngular, TypeScript", format: "text" as const };

  const indexed = await runtime.prepareInterview({ job: { company: "Acme", title: "Senior Angular Developer", description }, resume });
  expect(indexed.job.id).toBe("pasted:acme:senior-angular-developer");
  expect(indexed.fit.supported.map((item) => item.requirement)).toContain("Angular");
  expect([indexed.employer.indexed, indexed.employer.liveRoles]).toEqual([true, 2]);
  expect(indexed.employer.relatedRoles.map((role) => role.title)).toEqual(["Angular Developer", "QA Engineer"]);

  const elsewhere = await runtime.prepareInterview({ job: { company: "Apexon", title: "Angular Developer", description }, resume });
  expect([elsewhere.employer.indexed, elsewhere.employer.liveRoles]).toEqual([false, 0]);
  expect(elsewhere.brief.research.join(" ")).toContain("does not index Apexon");

  await expect(runtime.prepareInterview({ jobId: "x", job: { company: "A", title: "B", description }, resume })).rejects.toThrow("not both");
  await expect(runtime.prepareInterview({ job: { company: "A", title: "B", description: "Angular developer" }, resume })).rejects.toThrow("full job description");
});

test("the hosted runtime reads a job's description from the host when its index leaves descriptions out, so fit analysis has the requirements", async () => {
  const { createHostedRuntime } = await import("../src/runtime.ts");
  const listed = { ...job("8418847", "Software Engineer - Databricks", ""), id: "greenhouse:acme:8418847", description: "" };
  const store = { read: async () => ({ version: 1 as const, updatedAt: "2026-11-26T00:00:00Z", partitions: { acme: { fetchedAt: "2026-11-26T00:00:00Z", jobs: [listed] } }, lastCrawl: { startedAt: "", finishedAt: "", selected: 0, succeeded: 0, failed: [] } }), write: async () => {} };
  const stored = "What You Bring\n- Hands-on experience with AWS (S3, IAM, Glue)\n- Strong Python and SQL\n- Experience with orchestration tools such as Airflow\n- Hands-on experience with Databricks (Delta Lake, Spark)";
  const runtime = createHostedRuntime({ sources: [{ slug: "acme", name: "Acme", ats: "greenhouse", token: "acme" }], store, description: (id) => id === listed.id ? stored : undefined });
  expect((await runtime.get(listed.id)).job?.description).toBe(stored);
  const fit = await runtime.analyzeJobFit({ jobId: listed.id, resume: { format: "text", content: "Skills\nPython, SQL, PySpark, Apache Airflow, AWS (S3, IAM, Glue), Docker" } });
  expect(fit.supported.map((item) => item.requirement).sort()).toEqual(["AWS", "Airflow", "Python", "SQL", "Spark"]);
});
