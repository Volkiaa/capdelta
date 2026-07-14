import { describe, expect, it } from "vitest";
import { PROJECT_NAME } from "./index.js";

// Pipeline sanity check only: proves vitest resolves TS sources under the
// NodeNext/ESM config. Replaced by real tests at M1.
describe("toolchain sanity", () => {
  it("imports a TS module under NodeNext ESM resolution", () => {
    expect(PROJECT_NAME).toBe("capdelta");
  });
});
