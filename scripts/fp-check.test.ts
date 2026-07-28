import { describe, expect, it } from "vitest";
import { parseArguments } from "./fp-check.js";

describe("fp-check arguments", () => {
  it("accepts inert package lists and a bounded bump count", () => {
    expect(
      parseArguments(["--bumps", "5", "lodash", "@scope/package"]),
    ).toEqual({
      bumps: 5,
      packages: ["lodash", "@scope/package"],
    });
  });

  it.each([
    [[]],
    [["--bumps", "0", "lodash"]],
    [["--bumps", "21", "lodash"]],
    [["BadName"]],
    [["--unknown", "lodash"]],
  ])("rejects unsafe or unbounded input %j", (input) => {
    expect(() => parseArguments(input)).toThrow();
  });
});
