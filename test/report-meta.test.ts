import { expect, test } from "bun:test";
import { assertCompatibleReport, stampReport } from "../src/report-meta.ts";

test("report stamps cannot be overridden by payload metadata", () => {
  const report = stampReport("current:1", 2, { pipelineVersion: "forged", schemaVersion: 99, generatedAt: "invalid", value: 1 }, new Date("2026-08-10T00:00:00.000Z"));
  expect(report).toEqual({ pipelineVersion: "current:1", schemaVersion: 2, generatedAt: "2026-08-10T00:00:00.000Z", value: 1 });
});

test("report consumers reject missing, stale, and malformed metadata", () => {
  expect(() => assertCompatibleReport({}, "current:1", 1)).toThrow(/Incompatible report/);
  expect(() => assertCompatibleReport({ pipelineVersion: "old:1", schemaVersion: 1, generatedAt: "2026-08-10T00:00:00.000Z" }, "current:1", 1)).toThrow(/regenerate/);
  expect(() => assertCompatibleReport({ pipelineVersion: "current:1", schemaVersion: 1, generatedAt: "not-a-date" }, "current:1", 1)).toThrow(/Incompatible report/);
});
