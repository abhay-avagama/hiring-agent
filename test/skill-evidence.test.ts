import { expect, test } from "bun:test";
import { createJobFitAnalyzer } from "../src/job-fit-analysis.ts";
import { normalizeJobExperience } from "../src/experience.ts";
import { matchesExactSkillEvidence } from "../src/requirement-vocabulary.ts";
import type { Job } from "../src/types.ts";

test("skills written the normal way count: a bracketed list, a level word, a vendor prefix, a library for its engine", () => {
  for (const [requirement, skill] of [["aws", "AWS (S3"], ["airflow", "Apache Airflow"], ["terraform", "basic Terraform"], ["spark", "PySpark"], ["aws", "AWS Glue"], ["kubernetes", "K8s"]] as const)
    expect([requirement, skill, matchesExactSkillEvidence(requirement, skill)]).toEqual([requirement, skill, true]);
  // and the near misses stay misses
  for (const [requirement, skill] of [["java", "JavaScript"], ["sql", "NoSQL"], ["go", "Go-to-market"], ["spark", "Sparkling Water"], ["aws", "Redshift)"]] as const)
    expect([requirement, skill, matchesExactSkillEvidence(requirement, skill)]).toEqual([requirement, skill, false]);
});

test("a 'What You Bring' list with 'Strong Python and SQL' is read as requirements, and the nice-to-haves are not", async () => {
  // Marketing's demo case: Smartsheet "Software Engineer - Databricks", trimmed to the parts that matter.
  const description = ["What You'll Do", "- Build data pipelines on Databricks", "What You Bring",
    "- Hands-on experience with AWS (S3, IAM and services such as Glue, Lambda, EMR, Kinesis or Redshift)", "- Strong Python and SQL",
    "- Experience with orchestration tools such as Airbyte, Airflow or Databricks Workflows", "- Hands-on experience with Databricks (notebooks, Delta Lake, Spark)",
    "- Hands-on experience with Terraform or other Infrastructure-as-Code", "- Hands-on experience with Docker and/or Kubernetes",
    "Nice to Have", "- Experience with Snowflake, GCP"].join("\n");
  const job = normalizeJobExperience({ id: "pasted:smartsheet:se", company: "Smartsheet", title: "Software Engineer - Databricks", location: "Bengaluru", remote: false, workMode: "unknown",
    eligibleCountries: [], excludedCountries: [], eligibleRegions: [], eligibilityConfidence: "unknown", url: "", description }) as Job;
  const resume = { format: "text" as const, content: "Experience\nData Engineer, 2021-2026\n\nSkills\nPython, SQL, PySpark, Apache Airflow, AWS (S3, IAM, Glue, Lambda, EMR, Kinesis, Redshift), Git, Docker, basic Terraform" };
  const result = await createJobFitAnalyzer({ getJob: async () => job }).analyze({ jobId: job.id, resume });
  expect(result.supported.map((item) => item.requirement).sort()).toEqual(["AWS", "Airflow", "Docker", "Python", "SQL", "Spark", "Terraform"]);
  expect(result.unsupported.sort()).toEqual(["Databricks", "Kubernetes"]);
});
