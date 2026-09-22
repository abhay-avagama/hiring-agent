import { expect, test } from "bun:test";
import { matchesSearchTerms, searchHaystack, searchTerms } from "../src/text-match.ts";
import { extractSkills } from "../src/skills.ts";

/** A job whose description carries the skill is findable; the same job without it is not. */
function finds(title: string, description: string, query: string): boolean {
  const haystack = searchHaystack(`${title} Acme Corp ${extractSkills(description)}`);
  return matchesSearchTerms(haystack, searchTerms(query));
}

test("a term only in the description becomes searchable", () => {
  const description = "You will ship features in React Native and Kotlin for our Android app.";
  expect(finds("Software Engineer II", description, "react native")).toBe(true);
  expect(finds("Software Engineer II", description, "kotlin")).toBe(true);
  expect(finds("Software Engineer II", "You will ship features for our customers.", "react native")).toBe(false);
});

test("ordinary prose does not become a skill", () => {
  expect(extractSkills("We grew net profit while going to market in a large region.")).toBe("");
  expect(extractSkills("")).toBe("");
});

test("phrases need their words adjacent", () => {
  expect(extractSkills("Deep expertise in machine learning")).toContain("machine");
  expect(extractSkills("A learning mindset and a machine shop")).toBe("");
});

test("stored terms survive the matcher's stemming", () => {
  // The terms are stored already stemmed, so a second pass through the haystack must leave them alone.
  const once = extractSkills("Kubernetes, microservices and Terraform on AWS");
  expect(searchHaystack(once)).toBe(searchHaystack(searchHaystack(once).trim()));
  for (const query of ["kubernetes", "microservices", "terraform", "aws"]) {
    expect(matchesSearchTerms(searchHaystack(once), searchTerms(query))).toBe(true);
  }
});

test("technology names keep their punctuation", () => {
  const found = extractSkills("Strong C++ and C# background, plus Node.js");
  expect(matchesSearchTerms(searchHaystack(found), searchTerms("c++"))).toBe(true);
  expect(matchesSearchTerms(searchHaystack(found), searchTerms("c#"))).toBe(true);
  expect(matchesSearchTerms(searchHaystack(found), searchTerms("node.js"))).toBe(true);
  expect(matchesSearchTerms(searchHaystack(found), searchTerms("node"))).toBe(true);
});
