#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";

process.env.OPENINGS_DATA_DIR ??= join(homedir(), ".openings");
// Shared index: installs report crawled sources here and seed from it. Set OPENINGS_AGGREGATOR_URL to override, or to "" to keep crawls local.
process.env.OPENINGS_AGGREGATOR_URL ??= "https://openings.avagama.co";

const { serve } = await import("./mcp.ts");
await serve();
