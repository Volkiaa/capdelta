import { httpMessageOf, httpStatusOf } from "./http-error-fields.js";

/**
 * ADR-020: GitHub answers a write with HTTP 403 and "Resource not accessible
 * by integration" when the token lacks the required scope. GitHub also uses
 * 403 for secondary rate limits, so the status alone is not enough; the
 * message text is the discriminator.
 */
const REFUSAL_MESSAGE = "Resource not accessible by integration";

export function isPermissionRefusal(error: unknown): boolean {
  if (httpStatusOf(error) !== 403) return false;
  const message = httpMessageOf(error);
  return message?.includes(REFUSAL_MESSAGE) ?? false;
}
