/**
 * Minimal semver comparison for downgrade detection (PLAN §4.1). Hand-rolled
 * instead of the `semver` package to keep the runtime dependency count at
 * zero (PLAN §10): the differ needs ordering only, never ranges.
 */

const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedSemver {
  numbers: [number, number, number];
  /** Dot-separated prerelease identifiers; empty = release version. */
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    return null;
  }
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null; // unreachable given the regex, but noUncheckedIndexedAccess demands proof
  }
  return {
    numbers: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split("."),
  };
}

const NUMERIC_RE = /^\d+$/;

/** Semver §11: numeric identifiers compare numerically and rank below alphanumeric ones. */
function comparePrereleaseIds(a: string, b: string): -1 | 0 | 1 {
  const aNumeric = NUMERIC_RE.test(a);
  const bNumeric = NUMERIC_RE.test(b);
  if (aNumeric && bNumeric) {
    const diff = Number(a) - Number(b);
    return diff === 0 ? 0 : diff < 0 ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Total order per semver 2.0.0 (build metadata ignored). Returns null when
 * either version is not valid semver — the caller reports the change anyway,
 * so an undetermined ordering loses only the downgrade annotation, never the
 * diff itself.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) {
    return null;
  }

  for (let i = 0; i < 3; i++) {
    const diff = (pa.numbers[i] ?? 0) - (pb.numbers[i] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }

  // Equal x.y.z: a prerelease ranks below the corresponding release.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const longest = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < longest; i++) {
    const aId = pa.prerelease[i];
    const bId = pb.prerelease[i];
    // Semver §11: a larger set of equal-so-far identifiers ranks higher.
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const cmp = comparePrereleaseIds(aId, bId);
    if (cmp !== 0) return cmp;
  }
  return 0;
}
