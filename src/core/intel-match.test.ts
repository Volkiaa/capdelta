import { describe, expect, it } from "vitest";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import { intelMatches, type IntelFindingView } from "./intel-match.js";

const PACKAGE: ChangedPackage = {
  name: "left-pad",
  oldVersion: "1.0.0",
  newVersion: "1.1.0",
  oldIntegrity: "sha512-old",
  newIntegrity: "sha512-bad",
  oldResolvedUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
  resolvedUrl: "https://registry.npmjs.org/left-pad/-/left-pad-1.1.0.tgz",
};

function intel(overrides: Partial<IntelFindingView> = {}): IntelFindingView {
  return {
    id: "CDI-0123456789abcdef0123",
    ecosystem: "npm",
    name: "left-pad",
    version: "1.1.0",
    digest: "sha512-bad",
    verdict: "confirmed-malicious",
    ...overrides,
  };
}

describe("intelMatches", () => {
  it("turns a confirmed match on all four fields into a lockfile finding", () => {
    expect(intelMatches([PACKAGE], [intel()])).toEqual([
      {
        kind: "intel-confirmed-malicious",
        name: "left-pad",
        path: "intel:CDI-0123456789abcdef0123",
        oldVersion: "1.0.0",
        newVersion: "1.1.0",
        intelId: "CDI-0123456789abcdef0123",
      },
    ]);
  });

  it("does not match a different digest, version, name, or ecosystem", () => {
    for (const finding of [
      intel({ digest: "sha512-other" }),
      intel({ version: "1.1.1" }),
      intel({ name: "right-pad" }),
      intel({ ecosystem: "pypi" }),
    ]) {
      expect(intelMatches([PACKAGE], [finding])).toEqual([]);
    }
  });

  it("does not match any verdict other than confirmed-malicious", () => {
    for (const verdict of [
      "suspected",
      "under-review",
      "benign",
      "retracted",
      "some-future-verdict",
    ]) {
      expect(intelMatches([PACKAGE], [intel({ verdict })])).toEqual([]);
    }
  });

  it("returns one finding per matching package and finding id, sorted by name then id", () => {
    const secondPackage: ChangedPackage = {
      ...PACKAGE,
      name: "alpha",
      oldVersion: null,
      oldIntegrity: null,
      oldResolvedUrl: null,
    };
    const laterId = intel({ id: "CDI-bbbbbbbbbbbbbbbbbbbb" });
    const earlierId = intel({ id: "CDI-aaaaaaaaaaaaaaaaaaaa" });
    const alphaFinding = intel({
      id: "CDI-cccccccccccccccccccc",
      name: "alpha",
    });

    expect(
      intelMatches(
        [PACKAGE, secondPackage],
        [laterId, alphaFinding, earlierId, laterId],
      ),
    ).toEqual([
      {
        kind: "intel-confirmed-malicious",
        name: "alpha",
        path: "intel:CDI-cccccccccccccccccccc",
        oldVersion: null,
        newVersion: "1.1.0",
        intelId: "CDI-cccccccccccccccccccc",
      },
      {
        kind: "intel-confirmed-malicious",
        name: "left-pad",
        path: "intel:CDI-aaaaaaaaaaaaaaaaaaaa",
        oldVersion: "1.0.0",
        newVersion: "1.1.0",
        intelId: "CDI-aaaaaaaaaaaaaaaaaaaa",
      },
      {
        kind: "intel-confirmed-malicious",
        name: "left-pad",
        path: "intel:CDI-bbbbbbbbbbbbbbbbbbbb",
        oldVersion: "1.0.0",
        newVersion: "1.1.0",
        intelId: "CDI-bbbbbbbbbbbbbbbbbbbb",
      },
    ]);
  });

  it("returns an empty array for empty inputs", () => {
    expect(intelMatches([], [])).toEqual([]);
    expect(intelMatches([], [intel()])).toEqual([]);
    expect(intelMatches([PACKAGE], [])).toEqual([]);
  });
});
