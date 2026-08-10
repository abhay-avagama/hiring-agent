import { expect, test } from "bun:test";
import { verifyCandidates } from "../src/source-verification.ts";
import type { SourceCandidate } from "../src/types.ts";

const candidates: SourceCandidate[] = [
  {
    slug: "acme-stable", companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme",
    cohorts: ["IN"], discoveredFrom: { channel: "community", reference: "submission-1" },
  },
  {
    companyName: "Impostor", companyDomain: "impostor.test", sourceUrl: "https://job-boards.greenhouse.io/other",
    discoveredFrom: { channel: "dataset", reference: "dataset-row-2" },
  },
  {
    companyName: "Acme duplicate", companyDomain: "acme.test", sourceUrl: "https://boards.greenhouse.io/acme/jobs/1",
    discoveredFrom: { channel: "search", reference: "query" },
  },
  {
    companyName: "Acme", companyDomain: "attacker.test", sourceUrl: "https://jobs.lever.co/acme",
    discoveredFrom: { channel: "community", reference: "spoofed submission" },
  },
  {
    companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://jobs.ashbyhq.com/acme",
    discoveredFrom: { channel: "provider_directory", reference: "second source" },
  },
];

test("verified candidates are promoted while identity mismatches and duplicates are reported", async () => {
  const result = await verifyCandidates(candidates, {
    now: () => new Date("2026-08-10T10:00:00.000Z"),
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("api.lever.co")) return Response.json([{ id: "l1", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/l1", companyWebsite: "https://acme.test" }]);
      if (url.includes("api.ashbyhq.com")) return Response.json({ jobs: [{ id: "a1", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/a1", companyWebsite: "https://acme.test" }], apiVersion: "1" });
      if (url.includes("/acme/")) return Response.json({ jobs: [{ id: 1, company_name: "Acme", title: "Engineer", location: { name: "India" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", content: "Build" }] });
      return Response.json({ jobs: [{ id: 2, company_name: "Other", title: "Engineer", location: { name: "Remote" }, absolute_url: "https://job-boards.greenhouse.io/other/jobs/2", content: "Build" }] });
    },
  });

  expect(result.verified).toEqual([expect.objectContaining({
    slug: "acme-stable", name: "Acme", ats: "greenhouse", token: "acme", cohorts: ["IN"],
    verification: expect.objectContaining({ observedCompanyName: "Acme", checkedAt: "2026-08-10T10:00:00.000Z", jobCount: 1 }),
  })]);
  expect(result.rejected).toEqual([
    expect.objectContaining({ companyName: "Impostor", reason: "identity_mismatch" }),
    expect.objectContaining({ companyName: "Acme duplicate", reason: "duplicate_source" }),
    expect.objectContaining({ companyDomain: "attacker.test", reason: "identity_mismatch" }),
    expect.objectContaining({ sourceUrl: "https://jobs.ashbyhq.com/acme", reason: "duplicate_company" }),
  ]);
});
