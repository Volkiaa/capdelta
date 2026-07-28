const MAX_ERROR_CHAIN_LENGTH = 3;

export const MAX_CLI_ERROR_CHARS = 500;

export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CliUsageError extends CliError {}

export class CliOperationalError extends CliError {}

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
  const escaped = JSON.stringify(truncateCliMessage(message));
  return escaped.slice(1, -1);
}

export function truncateCliMessage(
  value: string,
  maxCharacters = MAX_CLI_ERROR_CHARS,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function errorSummary(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error;
}
