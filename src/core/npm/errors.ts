/**
 * Errors thrown when a whole lockfile is untrustworthy and no diff can be
 * produced at all. Per-entry problems never throw — they surface as
 * `SkippedPackage` flags instead (degrade loudly, PLAN §2).
 */

export type LockfileSide = "old" | "new";

export class LockfileError extends Error {
  readonly which: LockfileSide;

  constructor(message: string, which: LockfileSide) {
    super(`${which} lockfile: ${message}`);
    // new.target.name gives the concrete subclass name even when the error
    // is constructed via super() from a subclass.
    this.name = new.target.name;
    this.which = which;
  }
}

export class UnsupportedLockfileVersionError extends LockfileError {
  readonly lockfileVersion: unknown;

  constructor(which: LockfileSide, lockfileVersion: unknown) {
    // Only primitives are rendered; anything else (object, undefined, …)
    // shows its typeof — the value is attacker-influenced and not worth
    // serializing into an error message.
    const shown =
      typeof lockfileVersion === "number" || typeof lockfileVersion === "string"
        ? JSON.stringify(lockfileVersion)
        : `<${typeof lockfileVersion}>`;
    super(
      `unsupported lockfileVersion ${shown} (supported: 2, 3 — PLAN §2)`,
      which,
    );
    this.lockfileVersion = lockfileVersion;
  }
}

export class MalformedLockfileError extends LockfileError {
  constructor(which: LockfileSide, detail: string) {
    super(`malformed lockfile: ${detail}`, which);
  }
}
