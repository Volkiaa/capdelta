import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import { diffManifestCapabilities } from "./capability-differ.js";
import {
  extractNpmJavaScriptCapabilities,
  mergeJavaScriptCapabilityLayer,
} from "./npm/javascript-capability-extractor.js";
import { extractNpmManifestCapabilities } from "./npm/manifest-capability-extractor.js";
import { extractVerifiedTarball } from "./npm/safe-extractor.js";
import {
  renderJsonReport,
  renderJsonRunReport,
  renderTextReport,
  renderTextRunReport,
} from "./reporter.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../test/fixtures/golden/install-script-added/", import.meta.url),
);

describe("capability report golden pair", () => {
  it("reports an inert install script added from v1 to v2", async () => {
    const [
      oldBytes,
      newBytes,
      expectedJson,
      expectedText,
      expectedRunJson,
      expectedRunText,
    ] = await Promise.all([
      readFile(`${FIXTURE_ROOT}/v1.tgz`),
      readFile(`${FIXTURE_ROOT}/v2.tgz`),
      readFile(`${FIXTURE_ROOT}/expected.json`, "utf8"),
      readFile(`${FIXTURE_ROOT}/expected.txt`, "utf8"),
      readFile(`${FIXTURE_ROOT}/expected-run.json`, "utf8"),
      readFile(`${FIXTURE_ROOT}/expected-run.txt`, "utf8"),
    ]);
    const oldExtraction = await extractVerifiedTarball({
      integrity: "sha512-inert-golden-v1",
      bytes: oldBytes,
    });
    if (oldExtraction.status !== "extracted") {
      throw new Error(`old fixture rejected: ${oldExtraction.failure.detail}`);
    }
    try {
      const newExtraction = await extractVerifiedTarball({
        integrity: "sha512-inert-golden-v2",
        bytes: newBytes,
      });
      if (newExtraction.status !== "extracted") {
        throw new Error(
          `new fixture rejected: ${newExtraction.failure.detail}`,
        );
      }
      try {
        const oldAnalysis = await extractNpmManifestCapabilities(
          oldExtraction,
          { ecosystem: "npm", name: "golden-fixture", version: "1.0.0" },
        );
        const newAnalysis = await extractNpmManifestCapabilities(
          newExtraction,
          { ecosystem: "npm", name: "golden-fixture", version: "2.0.0" },
        );
        expect(oldAnalysis.status).toBe("analyzed");
        expect(newAnalysis.status).toBe("analyzed");
        if (oldAnalysis.status !== "analyzed") {
          throw new Error(
            `old manifest unavailable: ${oldAnalysis.failure.detail}`,
          );
        }
        if (newAnalysis.status !== "analyzed") {
          throw new Error(
            `new manifest unavailable: ${newAnalysis.failure.detail}`,
          );
        }

        const oldJavaScript = await extractNpmJavaScriptCapabilities(
          oldExtraction,
          oldAnalysis.set,
        );
        const newJavaScript = await extractNpmJavaScriptCapabilities(
          newExtraction,
          newAnalysis.set,
        );
        const oldSet = mergeJavaScriptCapabilityLayer(
          oldAnalysis.set,
          oldJavaScript,
        );
        const newSet = mergeJavaScriptCapabilityLayer(
          newAnalysis.set,
          newJavaScript,
        );
        const diff = diffManifestCapabilities(oldSet, newSet);
        expect(renderJsonReport(diff)).toBe(expectedJson);
        expect(renderTextReport(diff)).toBe(expectedText);
        const run: CapabilityAnalysisRun = {
          firstRun: false,
          summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
          packages: [
            {
              status: "analyzed",
              changedPackage: {
                name: "golden-fixture",
                oldVersion: "1.0.0",
                newVersion: "2.0.0",
                oldIntegrity: "sha512-inert-golden-v1",
                newIntegrity: "sha512-inert-golden-v2",
                oldResolvedUrl:
                  "https://registry.npmjs.org/golden-fixture/-/golden-fixture-1.0.0.tgz",
                resolvedUrl:
                  "https://registry.npmjs.org/golden-fixture/-/golden-fixture-2.0.0.tgz",
              },
              diff,
              issues: [],
            },
          ],
          lockfileFindings: [],
          skipped: [],
        };
        expect(renderJsonRunReport(run)).toBe(expectedRunJson);
        expect(renderTextRunReport(run)).toBe(expectedRunText);
      } finally {
        await newExtraction.cleanup();
      }
    } finally {
      await oldExtraction.cleanup();
    }
  });
});
