import { describe, expect, it } from "vitest";
import {
  MAX_CHILDREN_PER_RELEASE,
  resolveVersion,
  selectNewDependencies,
  specifierKind,
  type VersionResolution,
} from "./dependency-children.js";

function reasonOf(result: VersionResolution): string {
  if (!("reason" in result)) {
    throw new Error(`expected an unresolved specifier, got ${result.version}`);
  }
  return result.reason;
}

describe("selectNewDependencies", () => {
  it("selects a name the new version declares and the previous one did not", () => {
    const { selected, overflow } = selectNewDependencies(
      { dependencies: { alpha: "^1.0.0" } },
      { dependencies: {} },
    );

    expect(selected).toEqual([{ name: "alpha", specifier: "^1.0.0" }]);
    expect(overflow).toEqual([]);
  });

  it("selects optional dependencies and ignores peer and dev dependencies", () => {
    const { selected } = selectNewDependencies(
      {
        dependencies: {},
        optionalDependencies: { optional: "~2.0.0" },
        peerDependencies: { peer: "*" },
        devDependencies: { dev: "*" },
      },
      {},
    );

    expect(selected).toEqual([{ name: "optional", specifier: "~2.0.0" }]);
  });

  it("does not select a name the previous version already declared", () => {
    const { selected } = selectNewDependencies(
      { dependencies: { esbuild: "^0.21.0" } },
      { dependencies: { esbuild: "^0.20.0" } },
    );

    expect(selected).toEqual([]);
  });

  it("does not select a dependency whose range only changed", () => {
    const { selected } = selectNewDependencies(
      { dependencies: { sharp: "^0.34.0" } },
      { dependencies: { sharp: "^0.33.0" } },
    );

    expect(selected).toEqual([]);
  });

  it("expands nothing for a first release", () => {
    const { selected, overflow } = selectNewDependencies(
      { dependencies: { fresh: "^1.0.0" } },
      null,
    );

    expect(selected).toEqual([]);
    expect(overflow).toEqual([]);
  });

  it("lets optionalDependencies override dependencies for the same name", () => {
    const { selected } = selectNewDependencies(
      {
        dependencies: { twice: "^2.0.0" },
        optionalDependencies: { twice: "^1.0.0" },
      },
      {},
    );

    expect(selected).toEqual([{ name: "twice", specifier: "^1.0.0" }]);
  });

  it("does not select a name the previous version declared as a regular dependency", () => {
    const { selected } = selectNewDependencies(
      {
        dependencies: {},
        optionalDependencies: { moved: "^2.0.0" },
      },
      { dependencies: { moved: "^1.0.0" } },
    );

    expect(selected).toEqual([]);
  });

  it("sorts new names and caps the selection at 8", () => {
    const dependencies: Record<string, string> = {};
    for (let index = 0; index <= MAX_CHILDREN_PER_RELEASE; index += 1) {
      dependencies[`dep-${String(index)}`] = "^1.0.0";
    }

    const { selected, overflow } = selectNewDependencies({ dependencies }, {});

    expect(selected).toHaveLength(MAX_CHILDREN_PER_RELEASE);
    expect(selected[0]?.name).toBe("dep-0");
    expect(selected.at(-1)?.name).toBe("dep-7");
    expect(overflow).toEqual([{ name: "dep-8", specifier: "^1.0.0" }]);
  });
});

const VERSIONS = ["1.2.3", "1.2.9", "1.3.0", "2.0.0", "2.1.0-rc.1"];

describe("resolveVersion", () => {
  it("resolves an exact version", () => {
    expect(resolveVersion("1.2.3", VERSIONS, new Map())).toEqual({
      version: "1.2.3",
    });
  });

  it("resolves a caret range below the next major", () => {
    expect(resolveVersion("^1.2.3", VERSIONS, new Map())).toEqual({
      version: "1.3.0",
    });
  });

  it("resolves a caret range on a zero major below the next minor", () => {
    expect(
      resolveVersion("^0.2.3", ["0.2.3", "0.2.9", "0.3.0"], new Map()),
    ).toEqual({ version: "0.2.9" });
  });

  it("resolves a tilde range below the next minor", () => {
    expect(resolveVersion("~1.2.3", VERSIONS, new Map())).toEqual({
      version: "1.2.9",
    });
  });

  it("resolves a star to the highest stable version", () => {
    expect(resolveVersion("*", VERSIONS, new Map())).toEqual({
      version: "2.0.0",
    });
  });

  it("resolves x-ranges for a major, a minor and an explicit x", () => {
    expect(resolveVersion("1", VERSIONS, new Map())).toEqual({
      version: "1.3.0",
    });
    expect(resolveVersion("1.2", VERSIONS, new Map())).toEqual({
      version: "1.2.9",
    });
    expect(resolveVersion("1.2.x", VERSIONS, new Map())).toEqual({
      version: "1.2.9",
    });
  });

  it("resolves x and X as wildcards before any dist-tag lookup", () => {
    const tags = new Map([
      ["x", "1.2.3"],
      ["X", "1.2.3"],
    ]);

    expect(resolveVersion("x", VERSIONS, tags)).toEqual({ version: "2.0.0" });
    expect(resolveVersion("X", VERSIONS, tags)).toEqual({ version: "2.0.0" });
  });

  it("keeps an x-range inside its major even when a tag has the same name", () => {
    const tags = new Map([["1.x", "2.0.0"]]);

    expect(resolveVersion("1.x", VERSIONS, tags)).toEqual({ version: "1.3.0" });
    expect(resolveVersion("1.2.X", VERSIONS, new Map())).toEqual({
      version: "1.2.9",
    });
  });

  it("resolves latest and another dist-tag", () => {
    const tags = new Map([
      ["latest", "1.2.9"],
      ["next", "2.0.0"],
    ]);

    expect(resolveVersion("latest", VERSIONS, tags)).toEqual({
      version: "1.2.9",
    });
    expect(resolveVersion("next", VERSIONS, tags)).toEqual({
      version: "2.0.0",
    });
  });

  it("does not pick a prerelease", () => {
    expect(resolveVersion("*", ["1.0.0", "2.0.0-rc.1"], new Map())).toEqual({
      version: "1.0.0",
    });
    expect(reasonOf(resolveVersion("*", ["2.0.0-rc.1"], new Map()))).toContain(
      "no published version",
    );
  });

  it("reports an exact version that is not published", () => {
    expect(reasonOf(resolveVersion("9.9.9", VERSIONS, new Map()))).toContain(
      "no published version",
    );
  });

  it("reports an alias, URL, git and file specifier without a registry lookup", () => {
    for (const specifier of [
      "npm:real-package@^1.0.0",
      "https://example.invalid/child.tgz",
      "git+https://example.invalid/child.git",
      "github:owner/child",
      "file:../child",
    ]) {
      const result = resolveVersion(specifier, VERSIONS, new Map());
      expect("reason" in result).toBe(true);
    }
    expect(specifierKind("npm:real-package@^1.0.0")).toBe("alias");
    expect(specifierKind("https://example.invalid/child.tgz")).toBe("url");
    expect(specifierKind("github:owner/child")).toBe("git");
    expect(specifierKind("file:../child")).toBe("file");
  });

  it("reports unsupported comparator and hyphen ranges", () => {
    for (const specifier of [
      ">=1.0.0",
      ">=1.0.0 <2.0.0",
      "1.0.0 - 2.0.0",
      "||",
    ]) {
      expect(
        reasonOf(resolveVersion(specifier, VERSIONS, new Map())),
      ).toContain("unsupported");
    }
  });

  it("never reads a comparator range as a dist-tag", () => {
    const tags = new Map([[">=1.0.0", "2.0.0"]]);

    expect(reasonOf(resolveVersion(">=1.0.0", VERSIONS, tags))).toContain(
      "unsupported",
    );
  });

  it("reports a dist-tag the packument does not define", () => {
    expect(reasonOf(resolveVersion("beta", VERSIONS, new Map()))).toContain(
      "dist-tag",
    );
  });
});
