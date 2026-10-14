/**
 * ADR-020: GitHub answers a write with HTTP 403 and "Resource not accessible
 * by integration" when the token lacks the required scope. GitHub also uses
 * 403 for secondary rate limits, so the status alone is not enough; the
 * message text is the discriminator. Read the fields from `unknown` the same
 * way `statusFrom` does in base-lockfile-retriever.ts, before any wrapper
 * replaces the raw error.
 */
const REFUSAL_MESSAGE = "Resource not accessible by integration";

export function isPermissionRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return false;
  }
  if (error.status !== 403) return false;
  if (!("message" in error) || typeof error.message !== "string") return false;
  return error.message.includes(REFUSAL_MESSAGE);
}
