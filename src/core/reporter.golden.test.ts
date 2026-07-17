import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffManifestCapabilities } from "./capability-differ.js";
import { extractNpmManifestCapabilities } from "./npm/manifest-capability-extractor.js";
import { extractVerifiedTarball } from "./npm/safe-extractor.js";
import { renderJsonReport, renderTextReport } from "./reporter.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../test/fixtures/golden/install-script-added/", import.meta.url),
);

describe("manifest report golden pair", () => {
  it("reports an inert install script added from v1 to v2", async () => {
    const [oldBytes, newBytes, expectedJson, expectedText] = await Promise.all([
      readFile(`${FIXTURE_ROOT}/v1.tgz`),
      readFile(`${FIXTURE_ROOT}/v2.tgz`),
      readFile(`${FIXTURE_ROOT}/expected.json`, "utf8"),
      readFile(`${FIXTURE_ROOT}/expected.txt`, "utf8"),
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

        const diff = diffManifestCapabilities(oldAnalysis.set, newAnalysis.set);
        expect(renderJsonReport(diff)).toBe(expectedJson);
        expect(renderTextReport(diff)).toBe(expectedText);
      } finally {
        await newExtraction.cleanup();
      }
    } finally {
      await oldExtraction.cleanup();
    }
  });
});
