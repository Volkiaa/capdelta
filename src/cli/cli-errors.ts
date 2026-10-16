import { NamedError } from "../core/named-error.js";
import { truncate } from "../core/report-builder.js";

const MAX_ERROR_CHAIN_LENGTH = 3;

export const MAX_CLI_ERROR_CHARS = 500;

export class CliError extends NamedError {}

export class CliUsageError extends CliError {}

export class CliOperationalError extends CliError {}

export function terminalSafeText(value: string): string {
  return JSON.stringify(truncate(value, MAX_CLI_ERROR_CHARS)).slice(1, -1);
}

export function terminalSafeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CHAIN_LENGTH; depth += 1) {
    if (seen.has(current)) {
      messages.push("caused by [cycle]");
      break;
    }
    seen.add(current);
    messages.push(`${depth === 0 ? "" : "caused by "}${errorSummary(current)}`);
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  const message = messages.join("; ");
  const escaped = JSON.stringify(truncate(message, MAX_CLI_ERROR_CHARS));
  return escaped.slice(1, -1);
}

function errorSummary(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error;
}
