import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SET_SCHEMA_VERSION,
  type CapabilitySet,
} from "../contract/capability-set.js";
import { extractNpmJavaScriptCapabilities } from "./javascript-capability-extractor.js";

const manifestSet: CapabilitySet = {
  schemaVersion: CAPABILITY_SET_SCHEMA_VERSION,
  subject: { ecosystem: "npm", name: "fuzz-fixture", version: "1.0.0" },
  completeness: "complete",
  capabilities: [],
  diagnostics: [],
};

describe("Acorn walker malformed-source fuzzing", () => {
  it("returns findings or diagnostics for arbitrary source bytes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 1_024 }), async (bytes) => {
        const root = await mkdtemp(join(tmpdir(), "capdelta-ast-fuzz-"));
        try {
          await writeFile(
            join(root, "package.json"),
            JSON.stringify({ name: "fuzz-fixture", version: "1.0.0" }),
          );
          await writeFile(join(root, "index.js"), bytes);
          const result = await extractNpmJavaScriptCapabilities(
            { root },
            manifestSet,
          );
          expect(Array.isArray(result.capabilities)).toBe(true);
          expect(Array.isArray(result.diagnostics)).toBe(true);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 30 },
    );
  });
});
