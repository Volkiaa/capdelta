import {
  readRegularFile,
  type ReadRegularFileResult,
} from "../core/read-regular-file.js";
import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import { nameProblem } from "./registry-collector.js";

export class WatchlistError extends NamedError {}

/** The reader bounds its work before it trusts the file's shape. */
const MAX_WATCHLIST_BYTES = 1024 * 1024;
const MAX_WATCHLIST_LINES = 100_000;

/**
 * Reads a watchlist from text. Line order is rank order, so the first
 * package name is rank 0. Blank lines and `#` comments take no rank.
 */
export function parseWatchlist(text: string): ReadonlyMap<string, number> {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_WATCHLIST_BYTES) {
    throw new WatchlistError(
      `watchlist is larger than ${String(MAX_WATCHLIST_BYTES)} bytes`,
    );
  }

  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_WATCHLIST_LINES) {
    throw new WatchlistError(
      `watchlist has more than ${String(MAX_WATCHLIST_LINES)} lines; line ${String(MAX_WATCHLIST_LINES + 1)} is over the limit`,
    );
  }

  const packages = new Map<string, number>();
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const problem = nameProblem(line);
    if (problem !== null) {
      throw lineError(
        index + 1,
        `${problem}: ${JSON.stringify(truncate(line, MAX_IDENTITY_CHARS))}`,
      );
    }
    if (packages.has(line)) {
      throw lineError(
        index + 1,
        `duplicate package name ${JSON.stringify(truncate(line, MAX_IDENTITY_CHARS))}`,
      );
    }
    packages.set(line, packages.size);
  }
  if (packages.size === 0) {
    throw new WatchlistError(
      "watchlist is empty: it must name at least one package",
    );
  }
  return packages;
}

/**
 * Reads a watchlist file. It checks the size before the parse so an oversized
 * file cannot spend memory on a list the monitor would never accept.
 */
export async function readWatchlist(
  path: string,
): Promise<ReadonlyMap<string, number>> {
  const label = JSON.stringify(truncate(path, MAX_IDENTITY_CHARS));
  let read: ReadRegularFileResult;
  try {
    read = await readRegularFile(path, MAX_WATCHLIST_BYTES);
  } catch (error: unknown) {
    throw new WatchlistError(
      `cannot read watchlist ${label}: ${errorText(error)}`,
      { cause: error },
    );
  }
  if (read.kind === "not-regular") {
    throw new WatchlistError(`watchlist ${label} is not a regular file`);
  }
  if (read.kind === "too-large") {
    throw new WatchlistError(
      `watchlist ${label} is larger than ${String(MAX_WATCHLIST_BYTES)} bytes`,
    );
  }
  return parseWatchlist(read.bytes.toString("utf8"));
}

function lineError(line: number, detail: string): WatchlistError {
  return new WatchlistError(
    truncate(`watchlist line ${String(line)}: ${detail}`, MAX_VALUE_CHARS),
  );
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message, MAX_VALUE_CHARS);
}
