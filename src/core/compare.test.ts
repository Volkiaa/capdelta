import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareText } from "./compare.js";

describe("compareText", () => {
  it("orders any string array the same way as Array.prototype.sort", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (values) => {
        const expected = [...values].sort();
        const actual = [...values].sort(compareText);
        expect(actual).toEqual(expected);
      }),
    );
  });

  it("compares equal strings to 0", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(compareText(value, value)).toBe(0);
      }),
    );
  });
});
