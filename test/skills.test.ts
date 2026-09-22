import { expect, test } from "bun:test";
import { extractSkills } from "../src/skills.ts";
import { matchesSearchTerms, searchHaystack, searchTerms } from "../src/text-match.ts";

/** A job whose description states the skill is findable; the same job without it is not. */
function finds(title: string, description: string, query: string): boolean {
  return matchesSearchTerms(searchHaystack(`${title} Acme Corp ${extractSkills(description)}`), searchTerms(query));
}

test("a term only in the description becomes searchable", () => {
  const description = "You will ship features in React Native and Kotlin. Our React Native app is written in Kotlin.";
  expect(finds("Software Engineer II", description, "react native")).toBe(true);
  expect(finds("Software Engineer II", description, "kotlin")).toBe(true);
  expect(finds("Software Engineer II", "You will ship features for our customers.", "react native")).toBe(false);
});

test("a term named once is a passing reference, not a requirement", () => {
  // The line that separates "we also run Kubernetes somewhere" from a job that actually asks for it.
  expect(extractSkills("You will work with the team that runs our Kubernetes cluster.")).toBe("");
  expect(extractSkills("Deep Kubernetes experience. You will own our Kubernetes clusters.")).toBe("kubernete");
});

test("ordinary prose does not become a skill", () => {
  expect(extractSkills("We grew net profit while going to market in a large region, a large region indeed.")).toBe("");
  expect(extractSkills("")).toBe("");
});

test("phrases need their words adjacent", () => {
  expect(extractSkills("Machine learning throughout: machine learning models, machine learning pipelines")).toContain("machine");
  expect(extractSkills("A learning mindset and a machine shop. Another machine, more learning.")).toBe("");
});

test("stored terms survive the matcher's stemming", () => {
  // The terms are stored already stemmed, so a second pass through the haystack must leave them alone.
  const once = extractSkills("Kubernetes, microservices and Terraform on AWS. Kubernetes, microservices, Terraform, AWS.");
  expect(searchHaystack(once)).toBe(searchHaystack(searchHaystack(once).trim()));
  for (const query of ["kubernetes", "microservices", "terraform", "aws"]) {
    expect(matchesSearchTerms(searchHaystack(once), searchTerms(query))).toBe(true);
  }
});

test("technology names keep their punctuation", () => {
  const found = extractSkills("Strong C++ and C# background, plus Node.js. We write C++, C# and Node.js daily.");
  for (const query of ["c++", "c#", "node.js", "node"]) {
    expect([query, matchesSearchTerms(searchHaystack(found), searchTerms(query))]).toEqual([query, true]);
  }
});

test("the vocabulary names tools, not roles", () => {
  // A description that mentions DevOps or Android does not make the job one; its title is the evidence.
  const text = "Support our Android apps and work with DevOps. Android releases, DevOps pipelines, Android builds.";
  expect(extractSkills(text)).toBe("");
});
