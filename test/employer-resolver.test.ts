import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmployers, tokenGuesses } from "../src/employer-resolver.ts";

test("employer names become token guesses and provider probes turn hits into board leads", async () => {
  expect(tokenGuesses("Tata Consultancy Services")).toEqual(["tataconsultancy", "tata-consultancy", "tata"]);
  expect(tokenGuesses("S&P Global")).toEqual(["sp", "s-p"].filter((g) => g.length >= 3));
  const directory = await mkdtemp(join(tmpdir(), "openings-resolver-"));
  const signalsPath = join(directory, "signals.json"); const registryPath = join(directory, "leads.json"); const catalogPath = join(directory, "companies.json");
  await writeFile(signalsPath, JSON.stringify({ employers: [{ companyName: "Novartis", jobs: 14 }, { companyName: "Acme India", jobs: 3 }, { companyName: "Livspace", jobs: 81 }, { companyName: "Nobody Here", jobs: 2 }, { companyName: "Tiny", jobs: 1 }] }));
  await writeFile(catalogPath, JSON.stringify({ acme: { name: "Acme", companyDomain: "acme.test" } }));
  const fetcher = (async (url: string) => {
    if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/livspace/")) return Response.json({ jobs: [] });
    if (url.includes("api.smartrecruiters.com")) return Response.json({ totalFound: 0, content: [] });
    if (url.includes("apply.workable.com")) return Response.json({ name: "", jobs: [] });
    return new Response("", { status: 404 });
  }) as never;
  const headTransport = async (url: URL) => url.hostname !== "novartis.wd3.myworkdayjobs.com" ? new Response(null, { status: 404 }) : url.pathname === "/" ? new Response(null, { status: 302, headers: { location: "https://novartis.wd3.myworkdayjobs.com/en-US/Novartis_Careers" } }) : new Response(null, { status: 200 });
  const report = await resolveEmployers(signalsPath, { catalogPath, registryPath, minJobs: 2, fetcher, headTransport, resolveHost: async () => ["93.184.216.34"] });
  expect(report.probed).toBe(3);
  expect(report.found).toBe(2);
  expect(report.byProvider).toEqual({ workday: 1, greenhouse: 1 });
  expect(report.leads.map((lead) => lead.sourceUrl)).toEqual(["https://novartis.wd3.myworkdayjobs.com/en-US/Novartis_Careers", "https://job-boards.greenhouse.io/livspace"]);
  expect(report.unresolved).toEqual(["Nobody Here"]);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  expect(registry.leads.map((lead: { sourceKey: string }) => lead.sourceKey).sort()).toEqual(["greenhouse:livspace", "workday:novartis.wd3.myworkdayjobs.com/novartis/novartis_careers"]);
});
