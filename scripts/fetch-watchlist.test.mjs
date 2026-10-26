import { describe, expect, it } from "vitest";
import { parseTopJs } from "./fetch-watchlist.mjs";

describe("parseTopJs", () => {
  it("reads the package names from the top array in order", () => {
    const source = [
      "export const top = [",
      "  'semver',",
      "  '@scope/pkg',",
      '  "beta"',
      "];",
      "",
    ].join("\n");

    expect(parseTopJs(source)).toEqual(["semver", "@scope/pkg", "beta"]);
  });

  it("ignores quoted strings outside the top array", () => {
    const source = [
      "const other = ['not-a-package'];",
      "export const top = [",
      "  'alpha'",
      "];",
      "",
    ].join("\n");

    expect(parseTopJs(source)).toEqual(["alpha"]);
  });

  it("rejects a source with no top array", () => {
    expect(() => parseTopJs("export const other = [];")).toThrow(/top array/u);
  });

  it("reads an empty top array as an empty list", () => {
    expect(parseTopJs("export const top = [];")).toEqual([]);
  });
});
