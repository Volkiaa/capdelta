import { describe, expect, it } from "vitest";
import {
  featureIndexProblems,
  flagsMissingFromFeatures,
  unlistedBinHelpers,
} from "./check-skill.mjs";

describe("check-skill", () => {
  describe("unlistedBinHelpers", () => {
    it("accepts helpers the skill names", () => {
      expect(
        unlistedBinHelpers(
          ["doctor", "drive"],
          "Run bin/doctor, then bin/drive.",
        ),
      ).toEqual([]);
    });

    it("reports a helper the skill does not name", () => {
      expect(
        unlistedBinHelpers(["doctor", "cleanup"], "Run bin/doctor."),
      ).toEqual(["cleanup"]);
    });

    it("does not count a helper name inside a longer helper name", () => {
      expect(
        unlistedBinHelpers(["drive", "intel-drive"], "Run bin/intel-drive."),
      ).toEqual(["drive"]);
    });
  });

  describe("featureIndexProblems", () => {
    it("accepts an index that links every feature", () => {
      const index = "- [Gate](./gate.md)\n- [Edge paths](./edge-paths.md)";
      expect(featureIndexProblems(["gate.md", "edge-paths.md"], index)).toEqual(
        [],
      );
    });

    it("reports a feature file the index does not link", () => {
      const index = "- [Gate](./gate.md)";
      expect(featureIndexProblems(["gate.md", "edge-paths.md"], index)).toEqual(
        ["features/README.md does not link edge-paths.md"],
      );
    });

    it("reports a link to a missing feature file", () => {
      const index = "- [Gate](./gate.md)\n- [Gone](./gone.md)";
      expect(featureIndexProblems(["gate.md"], index)).toEqual([
        "features/README.md links to missing gone.md",
      ]);
    });

    it("ignores anchors and links outside the feature directory", () => {
      const index =
        "[Features](#features)\n[Skill](../SKILL.md)\n[Site](https://example.test)";
      expect(featureIndexProblems([], index)).toEqual([]);
    });
  });

  describe("flagsMissingFromFeatures", () => {
    it("accepts a flag any feature file mentions", () => {
      expect(
        flagsMissingFromFeatures(
          ["--base", "--strict"],
          ["Use `--base main`.", "Use `--strict` to fail loudly."],
        ),
      ).toEqual([]);
    });

    it("reports a flag no feature file mentions", () => {
      expect(
        flagsMissingFromFeatures(
          ["--base", "--intel-url"],
          ["Use `--base main`.", "The report is JSON."],
        ),
      ).toEqual(["--intel-url"]);
    });
  });
});
