import { expect, test } from "bun:test";
import { matchesSearchTerms, searchHaystack, searchTerms } from "../src/text-match.ts";

const matches = (title: string, query: string) => matchesSearchTerms(searchHaystack(title), searchTerms(query));

test("a term matches whole tokens, never a fragment of a longer word", () => {
  expect(matches("Senior iOS Engineer at Swiggy", "ios")).toBe(true);
  expect(matches("Regional Sales Manager at Axio Biosolutions", "ios")).toBe(false); // the panel's false match
  expect(matches("JavaScript Developer", "java")).toBe(false);
  expect(matches("Java Backend Developer", "java")).toBe(true);
  expect(matches("Head of Operations", "ops")).toBe(false);
});

test("technology names keep the characters that identify them", () => {
  const cases: Array<[string, string, boolean]> = [
    ["C++ Systems Engineer", "c++", true],
    ["C# .NET Developer", "c#", true],
    ["C# .NET Developer", ".net", true],
    ["C# .NET Developer", "net", true],
    ["Node.js Backend Engineer", "node.js", true],
    ["Node.js Backend Engineer", "node", true],
    ["React Native Developer", "react native", true],
    ["React Developer", "react native", false],
    ["Full-Stack Engineer", "full stack", true],
    ["Full Stack Engineer", "full-stack", true],
  ];
  for (const [title, query, expected] of cases) expect([title, query, matches(title, query)]).toEqual([title, query, expected]);
});

test("plurals meet in the middle and every term must appear", () => {
  expect(matches("Data Engineers wanted", "data engineer")).toBe(true);
  expect(matches("Data Engineer", "data engineers")).toBe(true);
  expect(matches("Data Engineer", "data scientist")).toBe(false);
  expect(matchesSearchTerms(searchHaystack("Anything"), searchTerms(""))).toBe(true);
});

test("word forms meet where they mean the same job, and not where they do not", () => {
  // Measured, not guessed: plural-only stemming lost 556 real roles to word form, while stripping "er" and "ment"
  // brought in 378 Business and Corporate Development titles for "developer" and Search Engine roles for "engineer".
  const cases: Array<[string, string, boolean]> = [
    ["Software Engineering Manager", "software engineer", true],
    ["Senior Software Engineer", "software engineering", true],
    ["Data Engineering Lead", "data engineer", true],
    ["Android Developers wanted", "android developer", true],
    ["Marketing Lead", "marketing", true],
    ["Business Development Manager", "java developer", false],
    ["Java Development Lead, Vice President", "java developer", false],
    ["Search Engine Optimization Specialist", "engineer", false],
    ["Customer Success Manager", "custom", false],
    ["Data Analyst", "data engineer", false],
  ];
  for (const [title, query, expected] of cases) expect([title, query, matches(title, query)]).toEqual([title, query, expected]);
});

test("a job written as one word and as two is the same job, without joining words that merely sit together", () => {
  const cases: Array<[string, string, boolean]> = [
    ["Fullstack Developer", "full stack", true],
    ["Full Stack Engineer", "fullstack", true],
    ["Backend Engineer", "back end", true],
    ["Front End Developer", "frontend", true],
    ["DevOps Engineer", "dev ops", true],
    ["Director, Clin Dev Ops", "devops", false], // Clinical Development Operations
  ];
  for (const [title, query, expected] of cases) expect([title, query, matches(title, query)]).toEqual([title, query, expected]);
});

test("reducing word forms does not bring the fragment matches back", () => {
  expect(matches("Regional Sales Manager at Axio Biosolutions", "ios")).toBe(false);
  expect(matches("JavaScript Developer", "java")).toBe(false);
  expect(matches("Salesforce Architect", "sales")).toBe(false);
  expect(matches("Flexera Software", "flex")).toBe(false);
});
