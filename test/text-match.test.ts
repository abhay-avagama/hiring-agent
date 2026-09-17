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
