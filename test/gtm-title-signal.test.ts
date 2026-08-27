import { expect, test } from "bun:test";
import { isExactEngineerTitle, titlePattern } from "../scripts/gtm-title-signal.ts";

test("isExactEngineerTitle matches only the full canonical title, not a containing phrase", () => {
  for (const title of ["GTM Engineer", "gtm engineer", "RevOps Engineer", "  GTM   Engineer  "]) {
    expect(isExactEngineerTitle(title)).toBe(true);
  }
  for (const title of ["Senior GTM Engineer", "GTM Engineer II", "RevOps Engineer, EMEA", "GTM Systems Manager", "Growth Engineer", ""]) {
    expect(isExactEngineerTitle(title)).toBe(false);
  }
  expect(isExactEngineerTitle(undefined)).toBe(false);
});

test("titlePattern is a broad signal pattern, deliberately looser than the exact-title check", () => {
  for (const title of ["Senior GTM Systems Manager", "RevOps Analyst", "Growth Engineer", "Growth Automation Lead", "Product Marketing Engineer"]) {
    expect(titlePattern.test(title)).toBe(true);
  }
  expect(titlePattern.test("Backend Engineer")).toBe(false);
});
