#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";

process.env.OPENINGS_DATA_DIR ??= join(homedir(), ".openings");

const { serve } = await import("./mcp.ts");
await serve();
