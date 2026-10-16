/**
 * Reads the HTTP status and message off an unknown error before any wrapper
 * replaces the raw error object.
 */

export function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}

export function httpMessageOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return null;
  }
  return typeof error.message === "string" ? error.message : null;
}
