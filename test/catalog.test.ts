import { describe, expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";

describe("job catalog", () => {
  test("searches Greenhouse jobs through the public catalog interface", async () => {
    const catalog = createCatalog({
      companies: [{ slug: "acme", name: "Acme", ats: "greenhouse", token: "acme" }],
      fetch: async () => Response.json({
        jobs: [{ id: 42, title: "Senior Platform Engineer", location: { name: "Remote - US" }, absolute_url: "https://acme.test/jobs/42", updated_at: "2026-08-01T00:00:00Z", content: "Build reliable distributed systems" }],
      }),
    });

    const jobs = await catalog.search({ query: "platform", remote: true });

    expect(jobs).toEqual([expect.objectContaining({
      id: "greenhouse:acme:42",
      company: "Acme",
      title: "Senior Platform Engineer",
      location: "Remote - US",
    })]);
  });

  test("normalizes Lever jobs and filters by location", async () => {
    const catalog = createCatalog({
      companies: [{ slug: "beta", name: "Beta Labs", ats: "lever", token: "beta" }],
      fetch: async () => Response.json([{
        id: "abc", text: "Product Designer", hostedUrl: "https://jobs.lever.co/beta/abc",
        categories: { location: "London, UK" }, descriptionPlain: "Design useful things",
        workplaceType: "hybrid", createdAt: 1_786_000_000_000,
      }]),
    });

    expect(await catalog.search({ location: "london" })).toEqual([expect.objectContaining({
      id: "lever:beta:abc", company: "Beta Labs", title: "Product Designer", remote: false,
    })]);
    expect(await catalog.search({ location: "berlin" })).toEqual([]);
  });

  test("searches Ashby with its public GET board protocol", async () => {
    let request: [string, RequestInit?] | undefined;
    const catalog = createCatalog({
      companies: [{ slug: "gamma", name: "Gamma", ats: "ashby", token: "gamma" }],
      fetch: async (input, init) => {
        request = [String(input), init];
        return Response.json({ jobs: [{
          id: "job-7", title: "Data Engineer", location: "New York, NY", isRemote: true,
          jobUrl: "https://jobs.ashbyhq.com/gamma/job-7", descriptionPlain: "Own data pipelines",
          publishedAt: "2026-08-02T00:00:00Z",
        }] });
      },
    });

    expect(await catalog.search({ query: "data", remote: true })).toEqual([
      expect.objectContaining({ id: "ashby:gamma:job-7", remote: true }),
    ]);
    expect(request).toEqual([
      "https://api.ashbyhq.com/posting-api/job-board/gamma",
      undefined,
    ]);
  });

  test("gets a full job by stable id and rejects unknown ids", async () => {
    let calls = 0;
    const catalog = createCatalog({
      companies: [{ slug: "acme", name: "Acme", ats: "greenhouse", token: "acme" }],
      fetch: async () => {
        calls += 1;
        return Response.json({ jobs: [{
          id: 42, title: "Engineer", location: { name: "Remote" },
          absolute_url: "https://acme.test/42", content: "<p>Build &amp; ship.</p>",
        }] });
      },
    });

    expect(await catalog.get("greenhouse:acme:42")).toEqual(expect.objectContaining({
      description: "Build & ship.", url: "https://acme.test/42",
    }));
    expect(await catalog.get("lever:missing:nope")).toBeNull();
    expect(calls).toBe(1);
  });

  test("keeps healthy boards searchable when another board is unavailable", async () => {
    const catalog = createCatalog({
      companies: [
        { slug: "down", name: "Down Inc", ats: "lever", token: "down" },
        { slug: "up", name: "Up Inc", ats: "lever", token: "up" },
      ],
      fetch: async (input) => {
        if (String(input).includes("/down?")) throw new Error("network unavailable");
        return Response.json([{ id: "1", text: "Engineer", hostedUrl: "https://up.test/1", categories: { location: "Remote" } }]);
      },
    });

    expect(await catalog.search({ query: "engineer" })).toHaveLength(1);
  });

  test("search returns summaries without full descriptions", async () => {
    const catalog = createCatalog({
      companies: [{ slug: "acme", name: "Acme", ats: "lever", token: "acme" }],
      fetch: async () => Response.json([{ id: "1", text: "Senior Data Engineer", hostedUrl: "https://acme.test/1", categories: { location: "Remote" }, descriptionPlain: "A very long description" }]),
    });

    const [job] = await catalog.search({ query: "engineer data" });
    expect(job).not.toHaveProperty("description");
  });

  test("matches common Indian city name variants", async () => {
    const catalog = createCatalog({
      companies: [{ slug: "acme", name: "Acme", ats: "greenhouse", token: "acme" }],
      fetch: async () => Response.json({ jobs: [{
        id: 1, title: "Backend Engineer", location: { name: "Bengaluru, Karnataka, India" },
        absolute_url: "https://acme.test/1", content: "Build systems",
      }] }),
    });

    expect(await catalog.search({ location: "Bangalore" })).toHaveLength(1);
  });

  test("filters India roles even when the ATS omits the country name", async () => {
    const catalog = createCatalog({
      companies: [{ slug: "acme", name: "Acme", ats: "lever", token: "acme" }],
      fetch: async () => Response.json([
        { id: "in", text: "Developer", hostedUrl: "https://acme.test/in", categories: { location: "Hyderabad" }, descriptionPlain: "Build" },
        { id: "apac", text: "Developer", hostedUrl: "https://acme.test/apac", categories: { location: "Remote - APAC" }, workplaceType: "remote", descriptionPlain: "Build across Asia" },
        { id: "state", text: "Developer", hostedUrl: "https://acme.test/state", categories: { location: "Karnataka" }, descriptionPlain: "Build" },
        { id: "foreign", text: "Developer", hostedUrl: "https://acme.test/foreign", categories: { location: "New York, US" }, descriptionPlain: "Collaborate with our India office" },
        { id: "excluded", text: "Developer", hostedUrl: "https://acme.test/excluded", categories: { location: "Remote - Global" }, workplaceType: "remote", descriptionPlain: "This role is not available in India or Asia" },
        { id: "us", text: "Developer", hostedUrl: "https://acme.test/us", categories: { location: "New York, US" }, descriptionPlain: "Build" },
      ]),
    });

    expect(await catalog.search({ country: "IN" })).toEqual([
      expect.objectContaining({ id: "lever:acme:in" }),
      expect.objectContaining({ id: "lever:acme:apac" }),
      expect.objectContaining({ id: "lever:acme:state" }),
    ]);
  });
});
