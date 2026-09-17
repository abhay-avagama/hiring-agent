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

test("word forms meet: a candidate typing engineer means Engineering too", () => {
  // A coverage panel measured the cost of plural-only stemming: 598 results removed, of which roughly 42
  // were genuine false matches. "engineering" alone absorbed "engineer" 514 times.
  const cases: Array<[string, string, boolean]> = [
    ["Software Engineering Manager", "software engineer", true],
    ["Senior Software Engineer", "software engineering", true],
    ["Data Engineering Lead", "data engineer", true],
    ["Development Manager", "developer", true],
    ["Engineering Management", "manager", true],
    ["Marketing Lead", "market", true],
    ["Data Analyst", "data engineer", false],
  ];
  for (const [title, query, expected] of cases) expect([title, query, matches(title, query)]).toEqual([title, query, expected]);
});

test("a job written as one word and as two is the same job", () => {
  const cases: Array<[string, string, boolean]> = [
    ["Fullstack Developer", "full stack", true],
    ["Full Stack Engineer", "fullstack", true],
    ["Backend Engineer", "back end", true],
    ["DevOps Engineer", "dev ops", true],
    ["Front End Developer", "frontend", true],
  ];
  for (const [title, query, expected] of cases) expect([title, query, matches(title, query)]).toEqual([title, query, expected]);
});

test("reducing word forms does not bring the fragment matches back", () => {
  expect(matches("Regional Sales Manager at Axio Biosolutions", "ios")).toBe(false);
  expect(matches("JavaScript Developer", "java")).toBe(false);
  expect(matches("Salesforce Architect", "sales")).toBe(false);
  expect(matches("Flexera Software", "flex")).toBe(false);
});
