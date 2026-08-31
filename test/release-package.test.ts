import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";
import mcpConfig from "../.mcp.json";

test("release package exposes only the candidate MCP entrypoint and excludes private project data", () => {
  expect(packageJson.bin).toEqual({ "openings-mcp": "./src/package-mcp.ts" });
  expect(packageJson.files).toContain("data/companies.json");
  expect(packageJson.files).not.toContain(".openings/");
  expect(packageJson.files).toContain("docs/job-seeker-quickstart.md");
  expect(packageJson.files).not.toContain("test/");
  expect(mcpConfig.mcpServers.openings).toEqual({ command: "bun", args: ["run", "src/package-mcp.ts"] });
});

test("packed artifact excludes private data and starts its MCP entrypoint", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "openings-release-"));
  try {
    const archive = join(temporary, `openings-${packageJson.version}.tgz`);
    const packed = Bun.spawnSync(["bun", "pm", "pack", "--destination", temporary, "--quiet"], {
      cwd: join(import.meta.dir, ".."), stderr: "pipe", stdout: "pipe",
    });
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);

    const listing = Bun.spawnSync(["tar", "-tzf", archive], { stderr: "pipe", stdout: "pipe" });
    expect(listing.exitCode, listing.stderr.toString()).toBe(0);
    const files = listing.stdout.toString().split("\n");
    expect(files).toContain("package/docs/job-seeker-quickstart.md");
    expect(files.some((file) => file.includes("Shubham_Bhamare") || file.includes(".openings/") || file.startsWith("package/test/"))).toBe(false);

    const installed = join(temporary, "installed");
    const bin = join(installed, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const unpacked = Bun.spawnSync(["tar", "-xzf", archive, "-C", installed], { stderr: "pipe", stdout: "pipe" });
    expect(unpacked.exitCode, unpacked.stderr.toString()).toBe(0);
    await symlink(join("..", "..", "package", "src", "package-mcp.ts"), join(bin, "openings-mcp"));
    const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`;
    const server = Bun.spawnSync([join(bin, "openings-mcp")], {
      cwd: installed,
      env: { ...process.env, HOME: join(temporary, "home") },
      stdin: new Blob([request]), stderr: "pipe", stdout: "pipe",
    });
    expect(server.exitCode, server.stderr.toString()).toBe(0);
    const response = JSON.parse(server.stdout.toString()) as { result: { tools: Array<{ name: string }> } };
    expect(response.result.tools.map((tool) => tool.name)).toContain("prepare_job_search");
    expect(response.result.tools).toHaveLength(7);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
