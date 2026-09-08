import { expect, test } from "bun:test";
import { resolveSource, verifyCandidates } from "../src/source-verification.ts";
import type { SourceCandidate } from "../src/types.ts";

test("resolves and verifies Recruitee through a structured company-domain link", async () => {
  expect(resolveSource("https://transperfect.recruitee.com/o/software-engineer")).toEqual({
    ats: "recruitee", token: "transperfect", canonicalSourceUrl: "https://transperfect.recruitee.com",
    structuredEndpoint: "https://transperfect.recruitee.com/api/offers",
  });
  const result = await verifyCandidates([{
    companyName: "TransPerfect", companyDomain: "transperfect.com", sourceUrl: "https://transperfect.recruitee.com/o/software-engineer",
    discoveredFrom: { channel: "provider_directory", reference: "https://transperfect.recruitee.com" },
  }], { fetch: async () => Response.json({ offers: [{ guid: "r-1", title: "Software Engineer", city: "Bangalore", country_code: "IN", careers_url: "https://transperfect.com/o/software-engineer" }] }) });

  expect(result.rejected).toEqual([]);
  expect(result.verified).toEqual([expect.objectContaining({
    ats: "recruitee", token: "transperfect", sourceUrl: "https://transperfect.recruitee.com",
    verification: expect.objectContaining({ identityEvidence: "structured_domain_link", payloadVersion: "recruitee-careers:v1", jobCount: 1 }),
  })]);
});

test("resolves and verifies a public Workday CXS source", async () => {
  const result = await verifyCandidates([{
    companyName: "Mastercard", companyDomain: "mastercard.com",
    sourceUrl: "https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers",
    discoveredFrom: { channel: "career_page", reference: "https://careers.mastercard.com" },
  }], { fetch: async () => Response.json({ total: 1, jobPostings: [{ title: "Engineer", externalPath: "/job/Pune-India/Engineer_R-1", locationsText: "Pune, India" }] }) });

  expect(result.rejected).toEqual([]);
  expect(result.verified).toEqual([expect.objectContaining({
    ats: "workday", token: "mastercard.wd1.myworkdayjobs.com/mastercard/CorporateCareers",
    sourceUrl: "https://mastercard.wd1.myworkdayjobs.com/en-US/CorporateCareers",
    verification: expect.objectContaining({ observedCompanyName: "mastercard", payloadVersion: "workday-cxs:v1", jobCount: 1 }),
  })]);
});

test("Workday resolution accepts only exact board or CXS jobs URL shapes", () => {
  expect(resolveSource("https://acme.wd1.myworkdayjobs.com/en-US/Careers")).toEqual(expect.objectContaining({
    ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/Careers",
    structuredEndpoint: "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs",
  }));
  expect(resolveSource("https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs")).toEqual(expect.objectContaining({
    ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/Careers",
  }));
  expect(resolveSource("https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/India/Engineer_R-1")).toEqual(expect.objectContaining({
    ats: "workday", token: "acme.wd1.myworkdayjobs.com/acme/Careers",
  }));
  for (const invalid of [
    "https://acme.wd1.myworkdayjobs.com/en-US/robots.txt",
    "https://acme.wd1.myworkdayjobs.com/robots.txt",
    "https://acme.wd1.myworkdayjobs.com/en-US/Careers/unrelated/path",
    "https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/India/Engineer_R-1/extra",
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs/extra",
    "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers",
  ]) expect(resolveSource(invalid)).toBeNull();
});

test("verifies Lever and Ashby boards discovered through company-owned redirects", async () => {
  const discoveredFrom = { channel: "career_page" as const, reference: "https://acme.test/careers" };
  const domainEvidence = { kind: "company_redirect" as const, reference: "https://acme.test/careers" };
  const result = await verifyCandidates([
    { companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://jobs.lever.co/acme", discoveredFrom, domainEvidence },
    { companyName: "Beta", companyDomain: "beta.test", sourceUrl: "https://jobs.ashbyhq.com/beta", discoveredFrom: { ...discoveredFrom, reference: "https://beta.test/jobs" }, domainEvidence: { ...domainEvidence, reference: "https://beta.test/jobs" } },
  ], { fetch: async (input) => String(input).includes("lever")
    ? Response.json([{ id: "l1", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/l1" }])
    : Response.json({ jobs: [{ id: "a1", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/beta/a1" }] }),
    resolveHost: async () => ["93.184.216.34"],
    headTransport: async (url) => url.hostname === "acme.test"
      ? new Response(null, { status: 302, headers: { location: "https://jobs.lever.co/acme" } })
      : url.hostname === "beta.test"
        ? new Response(null, { status: 302, headers: { location: "https://jobs.ashbyhq.com/beta" } })
        : new Response(null, { status: 200 }),
  });

  expect(result.rejected).toEqual([]);
  expect(result.verified.map((source) => source.ats)).toEqual(["lever", "ashby"]);
  expect(result.verified.map((source) => source.verification.identityEvidence)).toEqual(["company_redirect", "company_redirect"]);
});

test("rejects forged redirect evidence that does not land on the exact board", async () => {
  const result = await verifyCandidates([{
    companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://jobs.lever.co/acme",
    discoveredFrom: { channel: "career_page", reference: "https://acme.test/careers" },
    domainEvidence: { kind: "company_redirect", reference: "https://acme.test/careers" },
  }], {
    fetch: async () => Response.json([{ id: "1", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/1" }]),
    resolveHost: async () => ["93.184.216.34"],
    headTransport: async (url) => url.hostname === "acme.test" ? new Response(null, { status: 302, headers: { location: "https://jobs.lever.co/other" } }) : new Response(null, { status: 200 }),
  });
  expect(result.rejected[0]?.reason).toBe("identity_mismatch");
});

test("country retention checks the normalized complete feed", async () => {
  const candidate = { companyName: "Acme", companyDomain: "acme.test", sourceUrl: "https://job-boards.greenhouse.io/acme", cohorts: ["IN"], discoveredFrom: { channel: "dataset" as const, reference: "seed" } };
  const result = await verifyCandidates([candidate], { requireCountry: "IN", fetch: async () => Response.json({ jobs: [{ id: 1, company_name: "Acme", title: "Engineer", location: { name: "Berlin, Germany" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1", content: "Build" }] }) });
  expect(result.rejected[0]?.reason).toBe("no_country_jobs");
});

test("verification limits concurrent Workday sources independently of global concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const candidates = ["alpha", "beta", "gamma", "delta"].map((name) => ({
    companyName: name, companyDomain: `${name}.test`,
    sourceUrl: `https://${name}.wd1.myworkdayjobs.com/en-US/Careers`,
    discoveredFrom: { channel: "dataset" as const, reference: "enterprise-seed" },
  }));

  const result = await verifyCandidates(candidates, {
    concurrency: 4,
    providerConcurrency: { workday: 2 },
    fetch: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ total: 1, jobPostings: [{ title: "Engineer", externalPath: "/job/Engineer_R-1", locationsText: "India" }] });
    },
  });

  expect(result.verified).toHaveLength(4);
  expect(maximum).toBe(2);
});

test("verification retries a throttled provider response using Retry-After", async () => {
  let requests = 0;
  const result = await verifyCandidates([{
    companyName: "Acme", companyDomain: "acme.test",
    sourceUrl: "https://acme.wd1.myworkdayjobs.com/en-US/Careers",
    discoveredFrom: { channel: "dataset", reference: "enterprise-seed" },
  }], {
    fetch: async () => {
      requests += 1;
      if (requests === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ total: 1, jobPostings: [{ title: "Engineer", externalPath: "/job/Engineer_R-1", locationsText: "India" }] });
    },
  });

  expect(result.verified).toHaveLength(1);
  expect(requests).toBe(2);
});

test("a Workday-heavy input does not block other providers behind its provider limit", async () => {
  const started: string[] = [];
  const workday = ["one", "two", "three"].map((name) => ({ companyName: name, companyDomain: `${name}.test`, sourceUrl: `https://${name}.wd1.myworkdayjobs.com/en-US/Careers`, discoveredFrom: { channel: "dataset" as const, reference: "campaign" } }));
  const greenhouse = { companyName: "Fast", companyDomain: "fast.test", sourceUrl: "https://job-boards.greenhouse.io/fast", discoveredFrom: { channel: "dataset" as const, reference: "campaign" } };

  await verifyCandidates([...workday, greenhouse], {
    concurrency: 3, providerConcurrency: { workday: 1 },
    fetch: async (input) => {
      const url = String(input);
      started.push(url);
      if (url.includes("myworkdayjobs")) await new Promise((resolve) => setTimeout(resolve, 5));
      return url.includes("myworkdayjobs") ? Response.json({ total: 1, jobPostings: [{ title: "Engineer", externalPath: "/job/R-1" }] }) : Response.json({ jobs: [{ company_name: "Fast" }] });
    },
  });

  const lastWorkday = started.reduce((last, url, index) => url.includes("myworkdayjobs") ? index : last, -1);
  expect(started.findIndex((url) => url.includes("greenhouse"))).toBeLessThan(lastWorkday);
});

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

test("verifies Lever boards linked from the company's own careers page and rejects forged page links", async () => {
  const candidate = (reference: string, sourceUrl: string) => ({
    companyName: "Acme", companyDomain: "acme.test", sourceUrl,
    discoveredFrom: { channel: "career_page" as const, reference },
    domainEvidence: { kind: "company_page_link" as const, reference },
  });
  const options = {
    fetch: async () => Response.json([{ id: "l1", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/l1" }]),
    resolveHost: async () => ["93.184.216.34"],
    headTransport: async () => new Response(null, { status: 200 }),
    pageTransport: async (url: URL) => url.pathname === "/careers" ? new Response(`<a href="https://jobs.lever.co/acme">Jobs</a>`, { status: 200 }) : new Response("", { status: 404 }),
  };
  const good = await verifyCandidates([candidate("https://acme.test/careers", "https://jobs.lever.co/acme")], options);
  expect(good.rejected).toEqual([]);
  expect(good.verified[0]?.verification.identityEvidence).toBe("company_page_link");

  const wrongBoard = await verifyCandidates([candidate("https://acme.test/careers", "https://jobs.lever.co/other")], { ...options, fetch: async () => Response.json([{ id: "1", text: "Engineer", hostedUrl: "https://jobs.lever.co/other/1" }]) });
  expect(wrongBoard.rejected[0]?.reason).toBe("identity_mismatch");

  const foreignPage = await verifyCandidates([candidate("https://evil.test/careers", "https://jobs.lever.co/acme")], options);
  expect(foreignPage.rejected[0]?.reason).toBe("identity_mismatch");
});

test("verifies a Workday tenant that does not match the company name when the company's own careers page links to it", async () => {
  const workdayBody = { total: 1, jobPostings: [{ title: "Engineer", externalPath: "/job/Toulouse/Engineer_R1", locationsText: "Toulouse, France" }] };
  const candidate = {
    companyName: "Airbus (India)", companyDomain: "airbus.com", sourceUrl: "https://ag.wd3.myworkdayjobs.com/en-US/Airbus",
    discoveredFrom: { channel: "career_page" as const, reference: "https://www.airbus.com/en/careers" },
    domainEvidence: { kind: "company_page_link" as const, reference: "https://www.airbus.com/en/careers" },
  };
  const options = {
    fetch: async () => Response.json(workdayBody),
    resolveHost: async () => ["93.184.216.34"],
    headTransport: async () => new Response(null, { status: 200 }),
    pageTransport: async (url: URL) => url.pathname === "/en/careers" ? new Response(`<a href="https://ag.wd3.myworkdayjobs.com/en-US/Airbus">Jobs</a>`, { status: 200 }) : new Response("", { status: 404 }),
  };
  const result = await verifyCandidates([candidate], options);
  expect(result.rejected).toEqual([]);
  expect(result.verified[0]?.verification.identityEvidence).toBe("company_page_link");

  const unlinked = await verifyCandidates([{ ...candidate, domainEvidence: undefined, discoveredFrom: { channel: "search" as const, reference: "search" } }], options);
  expect(unlinked.rejected[0]?.reason).toBe("identity_mismatch");
});

test("SmartRecruiters account pages are not company boards", () => {
  expect(resolveSource("https://jobs.smartrecruiters.com/my-applications")).toBeNull();
  expect(resolveSource("https://jobs.smartrecruiters.com/AcmeCorp")?.token).toBe("AcmeCorp");
});
