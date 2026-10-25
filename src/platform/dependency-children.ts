import { MAX_IDENTITY_CHARS, truncate } from "../core/report-builder.js";

/** Depth 1, at most this many resolved children per release (ADR-045). */
export const MAX_CHILDREN_PER_RELEASE = 8;

export interface DeclaredDependency {
  name: string;
  specifier: string;
}

export interface ChildSelection {
  selected: DeclaredDependency[];
  overflow: DeclaredDependency[];
}

/** How a declared specifier reaches a child version, or why it cannot. */
export type SpecifierKind = "range" | "tag" | "alias" | "url" | "git" | "file";

export type VersionResolution = { version: string } | { reason: string };

/** Why a specifier this analyzer does not follow cannot name a child (ADR-045). */
export function unsupportedSpecifierReason(
  kind: Exclude<SpecifierKind, "range" | "tag">,
): string {
  return SPECIFIER_REASONS[kind];
}

const SPECIFIER_REASONS: Readonly<
  Record<Exclude<SpecifierKind, "range" | "tag">, string>
> = {
  alias: "npm alias specifiers are not resolved",
  url: "URL specifiers are not resolved",
  git: "git specifiers are not resolved",
  file: "file specifiers are not resolved",
};

const TAG_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/u;
const NUMERIC_PART = /^(?:0|[1-9]\d*)$/u;
const WILDCARD_PART = /^[xX*]$/u;
const RANGE_PREFIX = /^[\^~<>=]/u;
const HYPHEN_RANGE = /\s+-\s+/u;

type Triple = readonly [number, number, number];
type Matcher = (version: Triple) => boolean;

interface PartialVersion {
  /** One to three parts. A null part is `x`, `X` or `*`. */
  readonly parts: readonly (number | null)[];
}

/**
 * Calls the specifier a range, a dist-tag, or one of the forms this analyzer
 * deliberately does not follow (ADR-045). Range syntax wins over a dist-tag:
 * npm reads an exact version, a wildcard, an x-range, `^` and `~` as a range,
 * so a packument cannot point a tag named `x` at a different version.
 */
export function specifierKind(specifier: string): SpecifierKind {
  if (specifier.startsWith("npm:")) return "alias";
  if (
    /^file:/iu.test(specifier) ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(specifier)
  ) {
    return "file";
  }
  if (
    /^(?:git[+:]|ssh:\/\/|github:|gitlab:|bitbucket:|gist:)/iu.test(specifier)
  ) {
    return "git";
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(specifier)) return "url";
  if (specifier.includes("/")) return "git";
  if (isRangeForm(specifier)) return "range";
  if (TAG_PATTERN.test(specifier)) return "tag";
  return "range";
}

/**
 * True for every string npm reads as range syntax, including the forms this
 * analyzer does not resolve (comparators, `||` and hyphen ranges). Those stay
 * unresolved instead of falling through to a dist-tag lookup.
 */
function isRangeForm(specifier: string): boolean {
  if (RANGE_PREFIX.test(specifier) || specifier.includes("||")) return true;
  if (HYPHEN_RANGE.test(specifier)) return true;
  return parsePartial(specifier) !== null;
}

/**
 * Selects dependency names the current version declares and the previous
 * version did not. A name whose range merely changed is not new (ADR-045).
 * A first release has no previous declaration set, so it expands nothing.
 */
export function selectNewDependencies(
  current: unknown,
  previous: unknown,
): ChildSelection {
  if (previous === null || previous === undefined) {
    return { selected: [], overflow: [] };
  }
  const before = declaredDependencies(previous);
  const after = declaredDependencies(current);
  const fresh: DeclaredDependency[] = [];
  for (const [name, specifier] of after) {
    if (!before.has(name)) fresh.push({ name, specifier });
  }
  fresh.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return {
    selected: fresh.slice(0, MAX_CHILDREN_PER_RELEASE),
    overflow: fresh.slice(MAX_CHILDREN_PER_RELEASE),
  };
}

/** Resolves one specifier to the highest stable published version. */
export function resolveVersion(
  specifier: string,
  versions: readonly string[],
  distTags: ReadonlyMap<string, string>,
): VersionResolution {
  const kind = specifierKind(specifier);
  if (kind === "tag") return resolveTag(specifier, versions, distTags);
  if (kind !== "range") return { reason: unsupportedSpecifierReason(kind) };

  const matcher = rangeMatcher(specifier);
  if (matcher === null) {
    return { reason: "unsupported dependency specifier" };
  }
  let best: { version: string; triple: Triple } | null = null;
  for (const version of versions) {
    const triple = stableTriple(version);
    if (triple === null || !matcher(triple)) continue;
    if (best === null || compareTriples(triple, best.triple) > 0) {
      best = { version, triple };
    }
  }
  if (best === null) {
    return {
      reason: `no published version matches ${quote(specifier)}`,
    };
  }
  return { version: best.version };
}

function resolveTag(
  tag: string,
  versions: readonly string[],
  distTags: ReadonlyMap<string, string>,
): VersionResolution {
  const tagged = distTags.get(tag);
  if (tagged === undefined) {
    return { reason: `no dist-tag ${quote(tag)} in the packument` };
  }
  if (stableTriple(tagged) === null || !versions.includes(tagged)) {
    return {
      reason: `dist-tag ${quote(tag)} does not point to a stable published version`,
    };
  }
  return { version: tagged };
}

function declaredDependencies(manifest: unknown): Map<string, string> {
  const declared = new Map<string, string>();
  if (!isRecord(manifest)) return declared;
  // npm installs the optional entry when a name appears in both, so the later
  // field wins instead of being ignored.
  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const group = manifest[field];
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) {
      declared.set(name, typeof value === "string" ? value : "");
    }
  }
  return declared;
}

function rangeMatcher(range: string): Matcher | null {
  if (range.startsWith("^")) return caretMatcher(parsePartial(range.slice(1)));
  if (range.startsWith("~")) return tildeMatcher(parsePartial(range.slice(1)));
  const partial = parsePartial(range);
  if (partial === null) return null;
  if (partial.parts[0] === null) return () => true;
  return (version) =>
    partial.parts.every(
      (part, index) => part === null || version[index] === part,
    );
}

function caretMatcher(partial: PartialVersion | null): Matcher | null {
  if (partial === null) return null;
  const lower = lowerBound(partial);
  const upper: [number, number, number] = [...lower];
  const specified = partial.parts.filter(
    (part): part is number => part !== null,
  );
  const firstNonZero = partial.parts.findIndex(
    (part) => part !== null && part !== 0,
  );
  const bump = firstNonZero === -1 ? specified.length - 1 : firstNonZero;
  upper[bump] = (upper[bump] ?? 0) + 1;
  for (let index = bump + 1; index < upper.length; index += 1) upper[index] = 0;
  return within(lower, upper);
}

function tildeMatcher(partial: PartialVersion | null): Matcher | null {
  if (partial === null) return null;
  const lower = lowerBound(partial);
  const minor = partial.parts[1];
  const upper: Triple =
    minor === undefined || minor === null
      ? [lower[0] + 1, 0, 0]
      : [lower[0], minor + 1, 0];
  return within(lower, upper);
}

function lowerBound(partial: PartialVersion): [number, number, number] {
  const [major, minor, patch] = partial.parts;
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

function within(lower: Triple, upper: Triple): Matcher {
  return (version) =>
    compareTriples(version, lower) >= 0 && compareTriples(version, upper) < 0;
}

function parsePartial(value: string): PartialVersion | null {
  if (value.length === 0) return null;
  const pieces = value.split(".");
  if (pieces.length > 3) return null;
  const parts: (number | null)[] = [];
  let wildcard = false;
  for (const piece of pieces) {
    if (wildcard) {
      if (!WILDCARD_PART.test(piece)) return null;
      parts.push(null);
      continue;
    }
    if (WILDCARD_PART.test(piece)) {
      wildcard = true;
      parts.push(null);
      continue;
    }
    if (!NUMERIC_PART.test(piece)) return null;
    const part = Number(piece);
    if (!Number.isSafeInteger(part)) return null;
    parts.push(part);
  }
  return { parts };
}

/** Stable versions only: a prerelease never resolves (ADR-045). */
function stableTriple(version: string): Triple | null {
  const match = STABLE_VERSION.exec(version);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return [Number(major), Number(minor), Number(patch)];
}

function compareTriples(left: Triple, right: Triple): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
