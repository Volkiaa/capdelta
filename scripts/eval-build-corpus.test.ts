import { describe, expect, it } from "vitest";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import type { RegistryVersion } from "./fp-check.js";
import {
  EvalBuildError,
  assembleCorpus,
  benignEntries,
  choosePreviousVersion,
  maliciousEntries,
  syntheticEntries,
} from "./eval-build-corpus.js";

const pair: ChangedPackage = {
  name: "got",
  oldVersion: "15.0.6",
  newVersion: "15.0.7",
  oldIntegrity: "sha512-old",
  newIntegrity: "sha512-new",
  oldResolvedUrl: "https://registry.npmjs.org/got/-/got-15.0.6.tgz",
  resolvedUrl: "https://registry.npmjs.org/got/-/got-15.0.7.tgz",
};

const M5_SOURCE =
  "assumed benign: popular package adjacent bump (m5 frozen corpus)";

function version(value: string): RegistryVersion {
  return {
    version: value,
    tarball: `https://registry.npmjs.org/pkg/-/pkg-${value}.tgz`,
    integrity: `sha512-${value}`,
  };
}

describe("benignEntries", () => {
  it("names each transition and keeps the m5 source", () => {
    const entries = benignEntries([pair], {
      idPrefix: "benign:m5",
      source: M5_SOURCE,
    });
    expect(entries).toEqual([
      {
        id: "benign:m5:got:15.0.6->15.0.7",
        label: "benign",
        source: M5_SOURCE,
        provenance: "real-registry",
        pair,
      },
    ]);
  });
});

describe("maliciousEntries", () => {
  it("makes the advisory URL the source", () => {
    const entries = maliciousEntries([
      {
        pair: { ...pair, name: "faker" },
        source: "https://github.com/advisories/GHSA-5w9c-rv96-fr7g",
      },
    ]);
    expect(entries[0]?.id).toBe("malicious:faker:15.0.6->15.0.7");
    expect(entries[0]?.label).toBe("malicious");
    expect(entries[0]?.source).toBe(
      "https://github.com/advisories/GHSA-5w9c-rv96-fr7g",
    );
  });
});

describe("syntheticEntries", () => {
  it("labels reconstructions and carries no registry pair", () => {
    const entries = syntheticEntries([
      {
        id: "malicious:synthetic:axios-2026/attack",
        source: "https://example.test/advisory",
        resultOverride: {
          gateSeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
          incomplete: false,
        },
      },
    ]);
    expect(entries).toEqual([
      {
        id: "malicious:synthetic:axios-2026/attack",
        label: "malicious",
        source: "https://example.test/advisory",
        provenance: "synthetic-reconstruction",
        resultOverride: {
          gateSeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
          incomplete: false,
        },
      },
    ]);
  });
});

describe("choosePreviousVersion", () => {
  it("uses the named clean release when the registry still has it", () => {
    const versions = [version("1.4.0"), version("1.4.1")];
    expect(choosePreviousVersion(versions, "1.4.0", "1.4.1")?.version).toBe(
      "1.4.0",
    );
  });

  it("falls back to the highest remaining release below the malicious one", () => {
    const versions = [
      version("5.5.2"),
      version("5.5.3"),
      version("6.6.6"),
      version("7.0.0"),
    ];
    expect(choosePreviousVersion(versions, "6.6.5", "6.6.6")?.version).toBe(
      "5.5.3",
    );
  });

  it("returns undefined when nothing below the malicious release is left", () => {
    expect(
      choosePreviousVersion([version("6.6.6")], "6.6.5", "6.6.6"),
    ).toBeUndefined();
  });
});

describe("assembleCorpus", () => {
  const drafts = benignEntries(
    [pair, { ...pair, oldVersion: "15.0.7", newVersion: "15.1.0" }],
    { idPrefix: "benign:m5", source: M5_SOURCE },
  );
  const rule = {
    createdAt: "2026-10-24T00:00:00.000Z",
    splitRule: "held out when the salted hash is below the fraction",
    fraction: 0.3,
    salt: "capdelta-eval-2026-10-24",
  };

  it("is deterministic for the same inputs and rule", () => {
    expect(assembleCorpus(drafts, rule)).toEqual(assembleCorpus(drafts, rule));
  });

  it("assigns heldOut to every entry", () => {
    const corpus = assembleCorpus(drafts, rule);
    expect(corpus.entries).toHaveLength(2);
    expect(
      corpus.entries.every((entry) => typeof entry.heldOut === "boolean"),
    ).toBe(true);
  });

  it("holds nothing out at fraction 0 and everything at fraction 1", () => {
    expect(
      assembleCorpus(drafts, { ...rule, fraction: 0 }).entries.map(
        (entry) => entry.heldOut,
      ),
    ).toEqual([false, false]);
    expect(
      assembleCorpus(drafts, { ...rule, fraction: 1 }).entries.map(
        (entry) => entry.heldOut,
      ),
    ).toEqual([true, true]);
  });

  it("rejects duplicate ids", () => {
    const duplicate = drafts.at(0);
    if (duplicate === undefined) throw new Error("test fixture is empty");
    expect(() => assembleCorpus([duplicate, duplicate], rule)).toThrow(
      EvalBuildError,
    );
  });
});
