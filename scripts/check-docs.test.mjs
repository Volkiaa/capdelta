import { describe, expect, it } from "vitest";
import {
  cliFlags,
  missingFlags,
  readmeDependencyProblems,
} from "./check-docs.mjs";

describe("check-docs", () => {
  it("finds the flags in help text and ignores --help", () => {
    expect(
      cliFlags('"  --base <ref>", "  --intel-url <url>", "  --help"'),
    ).toEqual(["--base", "--intel-url"]);
  });

  it("reports a flag the CLI doc omits", () => {
    expect(
      missingFlags(["--base", "--intel-url"], "Use `--base main`."),
    ).toEqual(["--intel-url"]);
  });

  it("accepts a flag in the usage line or in code font", () => {
    expect(missingFlags(["--strict"], "Usage: capdelta [--strict]")).toEqual(
      [],
    );
    expect(missingFlags(["--strict"], "Usage: capdelta `--strict`")).toEqual(
      [],
    );
    expect(missingFlags(["--strict"], "Usage: capdelta strict")).toEqual([
      "--strict",
    ]);
  });

  it("flags a wrong count and a missing dependency", () => {
    const readme =
      "capdelta currently has seven direct runtime dependencies: `a`, `b`. More text.";
    expect(readmeDependencyProblems(readme, ["a", "b", "c"])).toEqual([
      "README says seven dependencies, package.json has 3",
      "README dependency list omits c",
    ]);
  });

  it("passes when the sentence matches", () => {
    const readme =
      "capdelta currently has two direct runtime\ndependencies: `a`, and `b`. More.";
    expect(readmeDependencyProblems(readme, ["a", "b"])).toEqual([]);
  });
});
