import { describe, expect, it } from "vitest";
import { isNormalizedRelativePosixPath } from "./repository-path.js";

describe("isNormalizedRelativePosixPath", () => {
  it.each([
    "package-lock.json",
    "apps/web/package-lock.json",
    "with space/ünïcode%#?.json",
  ])("accepts %s", (path) => {
    expect(isNormalizedRelativePosixPath(path)).toBe(true);
  });

  it.each([
    "",
    "/package-lock.json",
    "../package-lock.json",
    "apps/../package-lock.json",
    "./package-lock.json",
    "apps/./package-lock.json",
    "apps//package-lock.json",
    "apps/",
    "apps\\package-lock.json",
    "package-lock.json\0",
  ])("rejects %j", (path) => {
    expect(isNormalizedRelativePosixPath(path)).toBe(false);
  });
});
