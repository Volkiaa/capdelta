import { describe, expect, it } from "vitest";
import {
  MAX_RUNTIME_DEPS,
  countDirectRuntimeDeps,
  countTransitiveRuntimeDeps,
} from "./check-dep-budget.mjs";

describe("countDirectRuntimeDeps", () => {
  it("returns 0 when dependencies is absent", () => {
    expect(countDirectRuntimeDeps({})).toBe(0);
  });

  it("counts only runtime dependencies, not devDependencies", () => {
    const manifest = {
      dependencies: { acorn: "^8.0.0", "acorn-walk": "^8.0.0" },
      devDependencies: { vitest: "^3.0.0" },
    };
    expect(countDirectRuntimeDeps(manifest)).toBe(2);
  });
});

describe("countTransitiveRuntimeDeps", () => {
  it("excludes the root entry and dev-only packages", () => {
    const lockfile = {
      packages: {
        "": { name: "capdelta" },
        "node_modules/acorn": {},
        "node_modules/vitest": { dev: true },
        "node_modules/nested/node_modules/acorn": { dev: false },
      },
    };
    expect(countTransitiveRuntimeDeps(lockfile)).toBe(2);
  });

  it("returns 0 for a lockfile with no packages map", () => {
    expect(countTransitiveRuntimeDeps({})).toBe(0);
  });
});

describe("budget constant", () => {
  it("matches PLAN §10 (< 10 runtime dependencies)", () => {
    expect(MAX_RUNTIME_DEPS).toBe(10);
  });
});
