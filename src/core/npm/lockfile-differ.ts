/**
 * LockfileDiffer, npm implementation (PLAN §4.1). Takes two already-parsed
 * package-lock.json objects (v2/v3) and produces the ecosystem-agnostic
 * LockfileDiffResult. Retrieval (GitHub contents API, git show) is a separate
 * component — this one never touches the network or the filesystem.
 *
 * Both inputs are attacker-influenced in a PR context, so they arrive as
 * `unknown` and all structural validation happens here. Throw vs flag:
 * throw when the whole lockfile is untrustworthy; flag-and-continue
 * (SkippedPackage) when a single entry is unanalyzable.
 */

import type {
  ChangedPackage,
  LockfileDiffResult,
  LockfileFinding,
  SkipReason,
  SkippedPackage,
} from "../contract/lockfile-diff.js";
import {
  MalformedLockfileError,
  UnsupportedLockfileVersionError,
  type LockfileSide,
} from "./errors.js";
import { compareSemver } from "./semver.js";

const NPM_REGISTRY_HOST = "registry.npmjs.org";
const NODE_MODULES_SEGMENT = "node_modules/";

interface Entry {
  path: string;
  name: string;
  version: string | undefined;
  resolved: string | undefined;
  integrity: string | undefined;
  link: boolean;
}

type ParsedEntry =
  { ok: true; entry: Entry } | { ok: false; name: string; detail: string };

type Analyzability =
  | { analyzable: true; version: string; resolved: string; integrity: string }
  | { analyzable: false; reason: SkipReason; detail: string };

export function diffNpmLockfiles(
  oldLockfile: unknown,
  newLockfile: unknown,
): LockfileDiffResult {
  // Lockfile added in this PR → first-run mode (PLAN §4.1): every package is new.
  const firstRun = oldLockfile === null || oldLockfile === undefined;
  const newPackages = validateLockfile(newLockfile, "new");
  const oldPackages = firstRun ? {} : validateLockfile(oldLockfile, "old");

  const changed: ChangedPackage[] = [];
  const seenTuples = new Set<string>();
  const findings: LockfileFinding[] = [];
  const skipped: SkippedPackage[] = [];

  const oldByPath = new Map<string, Entry>();
  const oldByName = new Map<string, Entry[]>();
  for (const [path, raw] of Object.entries(oldPackages)) {
    if (!isDependencyPath(path)) continue;
    const parsed = parseEntry(path, raw);
    if (!parsed.ok) {
      // A malformed OLD entry is treated as absent for diffing (the new
      // version gets the newly-added full-report treatment — over-reporting,
      // never suppression) but the parse failure itself is still flagged:
      // no silent failures.
      skipped.push({
        name: parsed.name,
        path,
        reason: "malformed-entry",
        detail: `old lockfile: ${parsed.detail}; any new-side version is treated as newly added`,
      });
      continue;
    }
    oldByPath.set(path, parsed.entry);
    const siblings = oldByName.get(parsed.entry.name);
    if (siblings === undefined) {
      oldByName.set(parsed.entry.name, [parsed.entry]);
    } else {
      siblings.push(parsed.entry);
    }
  }

  for (const [path, raw] of Object.entries(newPackages)) {
    if (!isDependencyPath(path)) continue;
    const parsed = parseEntry(path, raw);
    if (!parsed.ok) {
      skipped.push({
        name: parsed.name,
        path,
        reason: "malformed-entry",
        detail: parsed.detail,
      });
      continue;
    }
    const entry = parsed.entry;

    let old: Entry | null = oldByPath.get(path) ?? null;
    if (old === null && !firstRun) {
      const moved = matchMoved(entry, oldByName);
      if (moved === "identical") continue;
      old = moved;
    }

    if (old !== null && sameArtifact(old, entry)) continue;

    // Findings derive from lockfile facts alone, so they are emitted even
    // when the entry is subsequently skipped (e.g. a downgraded private
    // package is still a reported downgrade).
    if (old?.version !== undefined && entry.version !== undefined) {
      // The integrity comparison requires BOTH sides present: an old entry
      // without an integrity field means integrity was added, not changed —
      // no tampered-bytes signal exists (review finding: false HIGH).
      if (
        old.version === entry.version &&
        old.integrity !== undefined &&
        old.integrity !== entry.integrity
      ) {
        findings.push({
          kind: "integrity-changed-version-same",
          name: entry.name,
          path,
          oldVersion: old.version,
          newVersion: entry.version,
        });
      } else if (compareSemver(entry.version, old.version) === -1) {
        // null (unparseable semver) intentionally emits nothing: the change
        // itself is still reported, only the downgrade annotation is lost.
        findings.push({
          kind: "version-downgrade",
          name: entry.name,
          path,
          oldVersion: old.version,
          newVersion: entry.version,
        });
      }
    }

    const verdict = classify(entry);
    if (!verdict.analyzable) {
      skipped.push({
        name: entry.name,
        path,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      continue;
    }

    // The baseline must be fetchable too (ADR-006): an old side that is
    // git/file/link, private-registry, or missing integrity/resolved cannot
    // be downloaded and diffed, so the package gets the newly-added
    // full-report treatment (PLAN 4.1) instead of a baseline the Fetcher
    // cannot honor. Over-reporting, never under.
    const oldVerdict = old === null ? null : classify(old);
    const baseline = oldVerdict?.analyzable === true ? oldVerdict : null;

    const candidate: ChangedPackage = {
      name: entry.name,
      oldVersion: baseline?.version ?? null,
      newVersion: verdict.version,
      oldIntegrity: baseline?.integrity ?? null,
      newIntegrity: verdict.integrity,
      oldResolvedUrl: baseline?.resolved ?? null,
      resolvedUrl: verdict.resolved,
    };
    // Same package bumped identically at several tree positions → analyzing
    // the tuple twice is pure waste; positions with differing deltas survive.
    // JSON.stringify is an injective encoding of the tuple; a separator join
    // cannot be, because attacker-controlled lockfile strings may contain any
    // character (including NUL via JSON unicode escapes) and collide across
    // field boundaries, silently dropping a distinct changed package.
    const tuple = JSON.stringify([
      candidate.name,
      candidate.oldVersion,
      candidate.newVersion,
      candidate.oldIntegrity,
      candidate.newIntegrity,
      candidate.oldResolvedUrl,
      candidate.resolvedUrl,
    ]);
    if (!seenTuples.has(tuple)) {
      seenTuples.add(tuple);
      changed.push(candidate);
    }
  }

  return { changed, findings, skipped, firstRun };
}

/** Root entry (""), workspace source dirs, and anything else outside node_modules is the repo's own code, not a dependency. */
function isDependencyPath(path: string): boolean {
  return path.includes(NODE_MODULES_SEGMENT);
}

function nameFromPath(path: string): string {
  const index = path.lastIndexOf(NODE_MODULES_SEGMENT);
  return index === -1 ? path : path.slice(index + NODE_MODULES_SEGMENT.length);
}

/** The one definition of "a plain JSON object" used on every untrusted-input boundary in this file. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Same installable artifact: version, integrity, AND resolved URL all equal.
 * Shared by the unchanged-check and matchMoved so the two can never diverge —
 * a copy whose tarball URL was re-pointed is a change wherever it sits in the
 * tree (review finding: the moved path used to ignore `resolved`).
 */
function sameArtifact(a: Entry, b: Entry): boolean {
  return (
    a.version === b.version &&
    a.integrity === b.integrity &&
    a.resolved === b.resolved
  );
}

function validateLockfile(
  input: unknown,
  which: LockfileSide,
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new MalformedLockfileError(which, "not a JSON object");
  }
  const version = input.lockfileVersion;
  if (version !== 2 && version !== 3) {
    throw new UnsupportedLockfileVersionError(which, version);
  }
  const packages = input.packages;
  if (!isPlainObject(packages)) {
    throw new MalformedLockfileError(
      which,
      `lockfileVersion ${String(version)} without a "packages" object`,
    );
  }
  return packages;
}

function parseEntry(path: string, raw: unknown): ParsedEntry {
  const fallbackName = nameFromPath(path);
  if (!isPlainObject(raw)) {
    return { ok: false, name: fallbackName, detail: "entry is not an object" };
  }
  const record = raw;
  for (const field of ["name", "version", "resolved", "integrity"] as const) {
    const value = record[field];
    if (value !== undefined && typeof value !== "string") {
      return {
        ok: false,
        name: fallbackName,
        detail: `"${field}" is not a string`,
      };
    }
  }
  const link = record.link;
  if (link !== undefined && typeof link !== "boolean") {
    return { ok: false, name: fallbackName, detail: '"link" is not a boolean' };
  }
  return {
    ok: true,
    entry: {
      path,
      // Aliases (npm:pkg@ver): the entry's "name" is the real registry
      // package; the path segment is only the install alias (PLAN §4.1).
      name: (record.name as string | undefined) ?? fallbackName,
      version: record.version as string | undefined,
      resolved: record.resolved as string | undefined,
      integrity: record.integrity as string | undefined,
      link: (record.link as boolean | undefined) ?? false,
    },
  };
}

/**
 * Approved moved-package rule for paths present only in the new lockfile:
 * an identical artifact (version+integrity+resolved, sameArtifact) existed
 * anywhere in the old tree → pure re-hoisting, ignore; exactly one distinct
 * old artifact of the name → treat as a version change from it; ambiguous or
 * unknown name → newly-added treatment (full report — the safe,
 * over-reporting direction). Distinctness is on the full artifact tuple, not
 * version alone: two old copies of one version with different integrities
 * must not yield an iteration-order-dependent baseline (review finding).
 */
function matchMoved(
  entry: Entry,
  oldByName: Map<string, Entry[]>,
): Entry | "identical" | null {
  const candidates = oldByName.get(entry.name);
  if (candidates === undefined) return null;
  if (candidates.some((c) => sameArtifact(c, entry))) {
    return "identical";
  }
  const distinctArtifacts = new Set(
    candidates.map((c) =>
      JSON.stringify([
        c.version ?? null,
        c.integrity ?? null,
        c.resolved ?? null,
      ]),
    ),
  );
  if (distinctArtifacts.size === 1) {
    return candidates[0] ?? null;
  }
  return null;
}

function classify(entry: Entry): Analyzability {
  if (entry.link) {
    return {
      analyzable: false,
      reason: "unanalyzable-source",
      detail: "workspace link entry",
    };
  }
  if (entry.version === undefined) {
    return {
      analyzable: false,
      reason: "malformed-entry",
      detail: "entry has no version",
    };
  }
  if (entry.resolved === undefined) {
    return {
      analyzable: false,
      reason: "missing-resolved",
      detail: "entry has no resolved URL",
    };
  }
  if (/^(?:git\+|git:|file:)/.test(entry.resolved)) {
    return {
      analyzable: false,
      reason: "unanalyzable-source",
      detail: `non-registry source: ${entry.resolved}`,
    };
  }
  let host: string;
  try {
    host = new URL(entry.resolved).host;
  } catch {
    return {
      analyzable: false,
      reason: "malformed-entry",
      detail: "resolved is not a valid URL",
    };
  }
  if (host !== NPM_REGISTRY_HOST) {
    // v0.1 rule (PLAN §2): any non-npmjs host is treated as private.
    // A mirror allowlist is future config, not a differ concern.
    return {
      analyzable: false,
      reason: "private-registry",
      detail: `registry host: ${host}`,
    };
  }
  if (entry.integrity === undefined) {
    return {
      analyzable: false,
      reason: "missing-integrity",
      detail:
        "registry entry has no integrity hash (fetcher requires SRI, PLAN §4.2)",
    };
  }
  return {
    analyzable: true,
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
  };
}
