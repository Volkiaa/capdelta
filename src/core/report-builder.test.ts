import { describe, expect, it } from "vitest";
import { truncate } from "./report-builder.js";

describe("truncate", () => {
  it("returns an empty string for a zero limit", () => {
    expect(truncate("value", 0)).toBe("");
  });

  it("returns only the ellipsis for a limit of one", () => {
    expect(truncate("value", 1)).toBe("\u2026");
  });

  it("returns a value of exactly the limit unchanged", () => {
    expect(truncate("value", 5)).toBe("value");
  });

  it("counts an astral character as one", () => {
    expect(truncate("\u{1f600}\u{1f600}\u{1f600}", 3)).toBe(
      "\u{1f600}\u{1f600}\u{1f600}",
    );
    expect(truncate("\u{1f600}\u{1f600}\u{1f600}", 2)).toBe("\u{1f600}\u2026");
  });
});
