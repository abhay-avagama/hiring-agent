export interface ReportMeta {
  schemaVersion: number;
  pipelineVersion: string;
  generatedAt: string;
}

export function stampReport<T extends object>(pipelineVersion: string, schemaVersion: number, payload: T, now = new Date()): T & ReportMeta {
  return { ...payload, schemaVersion, pipelineVersion, generatedAt: now.toISOString() };
}

export function assertCompatibleReport(value: unknown, pipelineVersion: string, schemaVersion: number): asserts value is ReportMeta & Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Report must be a JSON object");
  const report = value as Record<string, unknown>;
  if (report.pipelineVersion !== pipelineVersion || report.schemaVersion !== schemaVersion || typeof report.generatedAt !== "string" || !Number.isFinite(Date.parse(report.generatedAt))) {
    throw new Error(`Incompatible report: expected ${pipelineVersion} schema ${schemaVersion}; regenerate it with the current CLI`);
  }
}
