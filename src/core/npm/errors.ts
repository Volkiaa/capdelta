import { NamedError } from "../named-error.js";

/**
 * Errors thrown when a whole lockfile is untrustworthy and no diff can be
 * produced at all. Per-entry problems never throw — they surface as
 * `SkippedPackage` flags instead (degrade loudly, PLAN §2).
 */

export type LockfileSide = "old" | "new";

export class LockfileError extends NamedError {
  readonly which: LockfileSide;

  constructor(message: string, which: LockfileSide) {
    super(`${which} lockfile: ${message}`);
    this.which = which;
  }
}

export class UnsupportedLockfileVersionError extends LockfileError {
  readonly lockfileVersion: unknown;

  constructor(which: LockfileSide, lockfileVersion: unknown) {
    super(
      `unsupported lockfileVersion ${describeLockfileVersion(lockfileVersion)} (supported: 2, 3 — PLAN §2)`,
      which,
    );
    this.lockfileVersion = lockfileVersion;
  }
}

/** Renders a lockfile version for an error message: only primitives verbatim, anything else as its typeof, because the value is attacker-influenced and not worth serializing. */
export function describeLockfileVersion(value: unknown): string {
  return typeof value === "number" || typeof value === "string"
    ? JSON.stringify(value)
    : `<${typeof value}>`;
}

export class MalformedLockfileError extends LockfileError {
  constructor(which: LockfileSide, detail: string) {
    super(`malformed lockfile: ${detail}`, which);
  }
}
