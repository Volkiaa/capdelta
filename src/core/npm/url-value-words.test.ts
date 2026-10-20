import { describe, expect, it } from "vitest";
import { valueHasWords } from "./url-value-words.js";

describe("valueHasWords", () => {
  it.each([
    ["leading C0 controls", "\u0000\u001f https://a.test/x"],
    ["trailing C0 controls", "https://a.test/x\u0001\u000d"],
    ["an internal tab", "https://a.test/x\ty"],
    ["an internal carriage return", "https://a.test/x\ry"],
    ["an internal line feed", "https://a.test/x\ny"],
    ["a trailing no-break space", "https://a.test/x\u00a0"],
  ])("returns false for %s", (_label, value) => {
    expect(valueHasWords(value)).toBe(false);
  });

  it.each([
    ["an internal space", "https://a.test/x y"],
    ["an internal no-break space", "https://a.test/x\u00a0y"],
  ])("returns true for %s", (_label, value) => {
    expect(valueHasWords(value)).toBe(true);
  });
});
