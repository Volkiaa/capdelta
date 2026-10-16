export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
