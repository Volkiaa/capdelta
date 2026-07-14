import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffNpmLockfiles } from "./lockfile-differ.js";
import {
  MalformedLockfileError,
  UnsupportedLockfileVersionError,
} from "./errors.js";

/** Fixtures are committed, inert, handcrafted lockfiles (PLAN §7). */
function fixture(name: string): unknown {
  const url = new URL(
    `../../../test/fixtures/lockfiles/${name}`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, "utf8"));
}

describe("basic diff", () => {
  const result = diffNpmLockfiles(
    fixture("basic-old.json"),
    fixture("basic-new.json"),
  );

  it("reports a version bump with the full contract tuple", () => {
    expect(result.changed).toContainEqual({
      name: "bumped",
      oldVersion: "1.0.0",
      newVersion: "1.2.0",
      oldIntegrity: "sha512-FAKEbumpedOldAAAA==",
      newIntegrity: "sha512-FAKEbumpedNewAAAA==",
      oldResolvedUrl: "https://registry.npmjs.org/bumped/-/bumped-1.0.0.tgz",
      resolvedUrl: "https://registry.npmjs.org/bumped/-/bumped-1.2.0.tgz",
    });
  });

  it("reports an added package with null old fields and a scoped name derived from the path", () => {
    expect(result.changed).toContainEqual({
      name: "@scope/added-pkg",
      oldVersion: null,
      newVersion: "3.1.0",
      oldIntegrity: null,
      newIntegrity: "sha512-FAKEaddedAAAA==",
      oldResolvedUrl: null,
      resolvedUrl:
        "https://registry.npmjs.org/@scope/added-pkg/-/added-pkg-3.1.0.tgz",
    });
  });

  it("ignores unchanged, removed, and root entries; nothing skipped or flagged", () => {
    const names = result.changed.map((c) => c.name);
    expect(names).not.toContain("stable");
    expect(names).not.toContain("removed-pkg");
    expect(names).not.toContain("fixture-app");
    expect(result.changed).toHaveLength(2);
    expect(result.findings).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.firstRun).toBe(false);
  });
});

describe("aliases (npm:pkg@ver)", () => {
  it("reports the real registry name, not the install alias", () => {
    const result = diffNpmLockfiles(
      fixture("alias-old.json"),
      fixture("alias-new.json"),
    );
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.name).toBe("left-pad");
    expect(result.changed[0]?.newVersion).toBe("1.3.0");
  });
});

describe("same package at multiple tree positions", () => {
  const result = diffNpmLockfiles(
    fixture("multipos-old.json"),
    fixture("multipos-new.json"),
  );

  it("dedupes positions whose full change tuple is identical", () => {
    expect(result.changed.filter((c) => c.name === "dup")).toHaveLength(1);
  });

  it("keeps positions whose deltas differ", () => {
    const splits = result.changed.filter((c) => c.name === "split");
    expect(splits.map((c) => c.newVersion).sort()).toEqual(["1.5.0", "2.0.0"]);
  });
});

describe("integrity changed, version identical", () => {
  const result = diffNpmLockfiles(
    fixture("integrity-old.json"),
    fixture("integrity-new.json"),
  );

  it("emits the finding", () => {
    expect(result.findings).toContainEqual({
      kind: "integrity-changed-version-same",
      name: "pinned",
      path: "node_modules/pinned",
      oldVersion: "1.0.0",
      newVersion: "1.0.0",
    });
  });

  it("still queues the package for analysis — same version, different bytes", () => {
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.name).toBe("pinned");
    expect(result.changed[0]?.oldIntegrity).not.toBe(
      result.changed[0]?.newIntegrity,
    );
  });
});

describe("version downgrade", () => {
  const result = diffNpmLockfiles(
    fixture("downgrade-old.json"),
    fixture("downgrade-new.json"),
  );

  it("emits the finding and still queues the package", () => {
    expect(result.findings).toContainEqual({
      kind: "version-downgrade",
      name: "roll",
      path: "node_modules/roll",
      oldVersion: "2.0.0",
      newVersion: "1.9.0",
    });
    expect(result.changed.map((c) => c.name)).toContain("roll");
  });

  it("emits no downgrade finding when a version is not valid semver (change still reported)", () => {
    const make = (version: string) => ({
      lockfileVersion: 3,
      packages: {
        "node_modules/odd": {
          version,
          resolved: `https://registry.npmjs.org/odd/-/odd-${version}.tgz`,
          integrity: `sha512-FAKE${version}==`,
        },
      },
    });
    const result = diffNpmLockfiles(make("2.x-weird"), make("1.x-weird"));
    expect(result.findings).toHaveLength(0);
    expect(result.changed).toHaveLength(1);
  });
});

describe("git/file/link dependencies", () => {
  const result = diffNpmLockfiles(
    fixture("unanalyzable-old.json"),
    fixture("unanalyzable-new.json"),
  );

  it("skips and flags changed git, file, and link entries", () => {
    const reasons = new Map(result.skipped.map((s) => [s.name, s.reason]));
    expect(reasons.get("gitdep")).toBe("unanalyzable-source");
    expect(reasons.get("filedep")).toBe("unanalyzable-source");
    expect(reasons.get("linked")).toBe("unanalyzable-source");
    expect(result.changed).toHaveLength(0);
  });

  it("does not flag an unchanged git dependency", () => {
    expect(result.skipped.map((s) => s.name)).not.toContain("gitstable");
  });

  it("ignores workspace source paths outside node_modules", () => {
    expect(result.skipped.map((s) => s.path)).not.toContain("packages/linked");
  });
});

describe("private registries and missing fields", () => {
  const result = diffNpmLockfiles(
    fixture("private-old.json"),
    fixture("private-new.json"),
  );

  it("skips and flags a non-npmjs registry host, naming the host", () => {
    const corp = result.skipped.find((s) => s.name === "corp-pkg");
    expect(corp?.reason).toBe("private-registry");
    expect(corp?.detail).toContain("npm.corp.example.com");
  });

  it("skips registry entries without integrity or resolved", () => {
    const reasons = new Map(result.skipped.map((s) => [s.name, s.reason]));
    expect(reasons.get("nointegrity")).toBe("missing-integrity");
    expect(reasons.get("noresolved")).toBe("missing-resolved");
    expect(result.changed).toHaveLength(0);
  });
});

describe("moved packages (re-hoisting)", () => {
  const result = diffNpmLockfiles(
    fixture("moved-old.json"),
    fixture("moved-new.json"),
  );

  it("ignores a package that moved with identical version and integrity", () => {
    expect(result.changed.map((c) => c.name)).not.toContain("movedsame");
  });

  it("matches a moved package against the single old version of its name", () => {
    expect(result.changed).toContainEqual({
      name: "movedbump",
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      oldIntegrity: "sha512-FAKEmovedbumpOldAAAA==",
      newIntegrity: "sha512-FAKEmovedbumpNewAAAA==",
      oldResolvedUrl:
        "https://registry.npmjs.org/movedbump/-/movedbump-1.0.0.tgz",
      resolvedUrl: "https://registry.npmjs.org/movedbump/-/movedbump-2.0.0.tgz",
    });
  });

  it("treats an ambiguous match (multiple old versions) as newly added — safe over-report", () => {
    const ambig = result.changed.find((c) => c.name === "ambig");
    expect(ambig?.oldVersion).toBeNull();
    expect(ambig?.newVersion).toBe("2.0.0");
  });
});

describe("malformed entries", () => {
  it("flags the bad entry and keeps diffing its siblings", () => {
    const result = diffNpmLockfiles(
      fixture("malformed-old.json"),
      fixture("malformed-new.json"),
    );
    expect(result.skipped).toContainEqual({
      name: "badpkg",
      path: "node_modules/badpkg",
      reason: "malformed-entry",
      detail: '"version" is not a string',
    });
    expect(result.changed.map((c) => c.name)).toEqual(["goodpkg"]);
  });
});

describe("first run (lockfile added)", () => {
  it("treats every package as new and sets firstRun", () => {
    const result = diffNpmLockfiles(null, fixture("basic-new.json"));
    expect(result.firstRun).toBe(true);
    expect(result.changed).toHaveLength(3); // bumped, stable, @scope/added-pkg
    expect(
      result.changed.every(
        (c) =>
          c.oldVersion === null &&
          c.oldIntegrity === null &&
          c.oldResolvedUrl === null,
      ),
    ).toBe(true);
  });
});

describe("untrustworthy lockfiles throw", () => {
  it("rejects lockfileVersion 1, naming which side", () => {
    expect(() =>
      diffNpmLockfiles(fixture("v1.json"), fixture("basic-new.json")),
    ).toThrow(UnsupportedLockfileVersionError);
    try {
      diffNpmLockfiles(fixture("basic-old.json"), fixture("v1.json"));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedLockfileVersionError);
      expect((error as UnsupportedLockfileVersionError).which).toBe("new");
      expect((error as UnsupportedLockfileVersionError).message).toContain(
        "lockfileVersion 1",
      );
    }
  });

  it("rejects non-object input", () => {
    expect(() =>
      diffNpmLockfiles("garbage", fixture("basic-new.json")),
    ).toThrow(MalformedLockfileError);
    expect(() => diffNpmLockfiles(fixture("basic-old.json"), 42)).toThrow(
      MalformedLockfileError,
    );
  });

  it("rejects a v2/v3 lockfile without a packages map", () => {
    expect(() =>
      diffNpmLockfiles(fixture("basic-old.json"), { lockfileVersion: 3 }),
    ).toThrow(MalformedLockfileError);
  });
});

describe("review regressions", () => {
  const REG = "https://registry.npmjs.org";
  /** Minimal inline lockfile for regression cases too adversarial to keep as fixture files. */
  const lockfileWith = (packages: Record<string, unknown>): unknown => ({
    lockfileVersion: 3,
    packages: { "": { name: "fixture-app" }, ...packages },
  });

  it("does not silently drop a moved copy whose resolved URL was re-pointed", () => {
    const oldLf = lockfileWith({
      "node_modules/foo": {
        version: "1.0.0",
        resolved: `${REG}/foo/-/foo-1.0.0.tgz`,
        integrity: "sha512-FOO==",
      },
    });
    const newLf = lockfileWith({
      "node_modules/host/node_modules/foo": {
        version: "1.0.0",
        resolved: "https://evil.example.com/foo-1.0.0.tgz",
        integrity: "sha512-FOO==",
      },
    });
    const result = diffNpmLockfiles(oldLf, newLf);
    // Same version+integrity, different tarball host: must surface (here as a
    // private-registry skip), never vanish as "pure re-hoisting".
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ name: "foo", reason: "private-registry" }),
    );
  });

  it("keeps distinct changed packages whose dedup tuples collide under a separator join", () => {
    // Field values contain embedded NUL characters (reachable from real
    // lockfile JSON via \u0000 escapes). Under the previous NUL-separator
    // join, both positions produced the same dedup key and one distinct
    // change was silently dropped; JSON.stringify keys them apart.
    const oldLf = lockfileWith({
      "node_modules/col": {
        version: "1.0",
        resolved: `${REG}/col/-/col-old.tgz`,
        integrity: "OI",
      },
      "node_modules/h/node_modules/col": {
        version: "1.0",
        resolved: `${REG}/col/-/col-old.tgz`,
        integrity: "Z\u0000OI",
      },
    });
    const newLf = lockfileWith({
      "node_modules/col": {
        version: "2.0\u0000Z",
        resolved: `${REG}/col/-/col-new.tgz`,
        integrity: "NI",
      },
      "node_modules/h/node_modules/col": {
        version: "2.0",
        resolved: `${REG}/col/-/col-new.tgz`,
        integrity: "NI",
      },
    });
    expect(diffNpmLockfiles(oldLf, newLf).changed).toHaveLength(2);
  });

  it("emits no integrity-changed finding when the old entry merely lacked integrity", () => {
    const oldLf = lockfileWith({
      "node_modules/legacy": {
        version: "1.0.0",
        resolved: `${REG}/legacy/-/legacy-1.0.0.tgz`,
      },
    });
    const newLf = lockfileWith({
      "node_modules/legacy": {
        version: "1.0.0",
        resolved: `${REG}/legacy/-/legacy-1.0.0.tgz`,
        integrity: "sha512-NOWPRESENT==",
      },
    });
    const result = diffNpmLockfiles(oldLf, newLf);
    expect(result.findings).toHaveLength(0);
    // The unverifiable baseline gets the newly-added treatment (ADR-006).
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.oldVersion).toBeNull();
    expect(result.changed[0]?.oldIntegrity).toBeNull();
    expect(result.changed[0]?.oldResolvedUrl).toBeNull();
  });

  it("treats a moved package with one old version but two integrities as newly added, not an arbitrary baseline", () => {
    const oldLf = lockfileWith({
      "node_modules/amb": {
        version: "1.0.0",
        resolved: `${REG}/amb/-/amb-1.0.0.tgz`,
        integrity: "sha512-I1==",
      },
      "node_modules/h/node_modules/amb": {
        version: "1.0.0",
        resolved: `${REG}/amb/-/amb-1.0.0.tgz`,
        integrity: "sha512-I2==",
      },
    });
    const newLf = lockfileWith({
      "node_modules/newhost/node_modules/amb": {
        version: "1.0.0",
        resolved: `${REG}/amb/-/amb-1.0.0.tgz`,
        integrity: "sha512-I3==",
      },
    });
    const result = diffNpmLockfiles(oldLf, newLf);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.oldVersion).toBeNull();
  });

  it("flags a malformed old-side entry instead of dropping it silently", () => {
    const oldLf = lockfileWith({
      "node_modules/badold": { version: 42 },
    });
    const newLf = lockfileWith({
      "node_modules/badold": {
        version: "1.1.0",
        resolved: `${REG}/badold/-/badold-1.1.0.tgz`,
        integrity: "sha512-NEW==",
      },
    });
    const result = diffNpmLockfiles(oldLf, newLf);
    const flagged = result.skipped.find((s) => s.name === "badold");
    expect(flagged?.reason).toBe("malformed-entry");
    expect(flagged?.detail).toContain("old lockfile:");
    expect(result.changed).toContainEqual(
      expect.objectContaining({ name: "badold", oldVersion: null }),
    );
  });

  it("gives newly-added treatment when the old side is not a fetchable registry baseline", () => {
    const oldLf = lockfileWith({
      "node_modules/corp": {
        version: "1.0.0",
        resolved: "https://npm.corp.example.com/corp/-/corp-1.0.0.tgz",
        integrity: "sha512-OLD==",
      },
    });
    const newLf = lockfileWith({
      "node_modules/corp": {
        version: "2.0.0",
        resolved: `${REG}/corp/-/corp-2.0.0.tgz`,
        integrity: "sha512-NEW==",
      },
    });
    const result = diffNpmLockfiles(oldLf, newLf);
    expect(result.changed).toContainEqual(
      expect.objectContaining({
        name: "corp",
        oldVersion: null,
        oldResolvedUrl: null,
        newVersion: "2.0.0",
      }),
    );
    expect(result.skipped).toHaveLength(0);
  });

  it("upholds the oldResolvedUrl invariant: non-null exactly when oldVersion is", () => {
    const result = diffNpmLockfiles(
      fixture("basic-old.json"),
      fixture("basic-new.json"),
    );
    for (const c of result.changed) {
      expect(c.oldResolvedUrl === null).toBe(c.oldVersion === null);
    }
  });
});
