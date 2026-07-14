import { describe, expect, it } from "vitest";
import { compareSemver } from "./semver.js";

describe("compareSemver", () => {
  it("orders numeric components numerically, not lexically", () => {
    expect(compareSemver("1.2.3", "1.10.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("ranks a prerelease below its release", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
  });

  it("compares prerelease identifiers per semver §11", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1); // fewer ids < more ids
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-beta")).toBe(-1); // alpha < beta
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1); // numeric < alphanumeric
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1); // numeric ids numeric
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });

  it("ignores build metadata", () => {
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(compareSemver("1.0.0-rc.1+abc", "1.0.0-rc.1")).toBe(0);
  });

  it("returns null for non-semver input instead of guessing", () => {
    expect(compareSemver("not-a-version", "1.0.0")).toBeNull();
    expect(compareSemver("1.0.0", "1.0")).toBeNull();
    expect(compareSemver("", "")).toBeNull();
  });
});
