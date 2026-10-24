import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NamedError } from "../../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../../core/report-builder.js";

export class ReviewersError extends NamedError {}

export interface Reviewers {
  authenticate(token: string): string | null;
}

interface Entry {
  hash: string;
  name: string;
}

const TOKEN_PREFIX = "cdr_";
const TOKEN_BYTES = 32;
const MAX_TOKEN_CHARS = 200;
const ANALYZER = "analyzer";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** The stored form of a token, so the file never holds one that can be used. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createReviewers(entries: Record<string, string>): Reviewers {
  const parsed = parseEntries(entries);

  return {
    authenticate(token: string): string | null {
      // Hashing a huge token before rejecting it would let a caller spend our CPU.
      if (token.length > MAX_TOKEN_CHARS) return null;
      const presented = Buffer.from(hashToken(token), "hex");
      let matched: string | null = null;
      // Every entry is compared so the time taken does not reveal a match position.
      for (const entry of parsed) {
        const key = Buffer.from(entry.hash, "hex");
        if (key.length !== presented.length) continue;
        if (timingSafeEqual(key, presented)) matched = entry.name;
      }
      return matched;
    },
  };
}

export function parseReviewersFile(text: string): Reviewers {
  const record = parseJsonObject(text);
  const entries: Record<string, string> = {};

  for (const [key, value] of Object.entries(record)) {
    if (!HASH_PATTERN.test(key)) throw invalidKey(key);
    if (typeof value !== "string") {
      throw new ReviewersError(
        `invalid reviewers entry ${quote(key)}: the name must be a string`,
      );
    }
    entries[key] = value;
  }
  if (Object.keys(entries).length === 0) {
    throw new ReviewersError(
      "the reviewers file must contain at least one entry",
    );
  }
  return createReviewers(entries);
}

/** The name rules the file parser applies, for a name typed on the command line. */
export function validateReviewerName(name: string): string {
  return parseName(name, null);
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

function parseEntries(entries: Record<string, string>): Entry[] {
  const parsed = Object.entries(entries).map(([key, name]) => {
    if (!HASH_PATTERN.test(key)) throw invalidKey(key);
    return { hash: key, name: parseName(name, key) };
  });
  if (parsed.length === 0) {
    throw new ReviewersError("at least one reviewer entry is required");
  }
  return parsed;
}

function parseName(value: string, key: string | null): string {
  const context =
    key === null ? "reviewer name" : `reviewers entry ${quote(key)}`;
  const name = value.trim();
  if (name.length === 0) {
    throw new ReviewersError(`invalid ${context}: the name must not be empty`);
  }
  if (Array.from(name).length > MAX_IDENTITY_CHARS) {
    throw new ReviewersError(
      `invalid ${context}: the name is longer than ${String(MAX_IDENTITY_CHARS)} characters`,
    );
  }
  if (name.toLowerCase() === ANALYZER) {
    throw new ReviewersError(
      `invalid ${context}: the name must not be "analyzer"`,
    );
  }
  return name;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReviewersError(
        `the reviewers file is not valid JSON: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewersError("the reviewers file must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function invalidKey(key: string): ReviewersError {
  return new ReviewersError(
    `invalid reviewers entry: key ${quote(key)} must be 64 lowercase hex characters`,
  );
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_VALUE_CHARS));
}
