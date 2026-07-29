import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { extractVerifiedTarball } from "./safe-extractor.js";

describe("extractVerifiedTarball malformed-archive fuzzing", () => {
  it("never throws or executes content for arbitrary archive bytes", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4_096 }), async (bytes) => {
        const result = await extractVerifiedTarball({
          integrity: "sha512-fuzz-fixture",
          bytes,
        });
        if (result.status === "extracted") {
          await result.cleanup();
        } else {
          expect(result.failure.kind).toBeTruthy();
        }
      }),
      { numRuns: 50 },
    );
  });
});
