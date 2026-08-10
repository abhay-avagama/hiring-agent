import type { SourceDiscoveryReport } from "./source-discovery.ts";
import { runSourceVerification, type SourcePipelineReport } from "./source-pipeline.ts";

interface PromotionOptions {
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  concurrency?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export interface DiscoveryPromotionResult {
  discovery: SourceDiscoveryReport;
  promotion: SourcePipelineReport;
}

export async function discoverAndPromote(
  discover: () => Promise<SourceDiscoveryReport>,
  candidatesPath: string,
  catalogPath: string,
  options: PromotionOptions = {},
): Promise<DiscoveryPromotionResult> {
  const discovery = await discover();
  const promotion = await runSourceVerification(candidatesPath, catalogPath, options);
  return { discovery, promotion };
}
