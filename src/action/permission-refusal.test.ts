import { describe, expect, it } from "vitest";
import { isPermissionRefusal } from "./permission-refusal.js";

const REFUSAL = "Resource not accessible by integration";

describe("isPermissionRefusal", () => {
  it("accepts the 403 GitHub sends when the token lacks a permission", () => {
    expect(
      isPermissionRefusal(Object.assign(new Error(REFUSAL), { status: 403 })),
    ).toBe(true);
  });

  it("rejects a 403 used for a secondary rate limit", () => {
    expect(
      isPermissionRefusal(
        Object.assign(new Error("You have exceeded a secondary rate limit"), {
          status: 403,
        }),
      ),
    ).toBe(false);
  });

  it.each([
    ["a 404", Object.assign(new Error(REFUSAL), { status: 404 })],
    ["a plain Error", new Error(REFUSAL)],
    ["a string", REFUSAL],
    ["null", null],
  ] as const)("rejects %s", (_label, error) => {
    expect(isPermissionRefusal(error)).toBe(false);
  });
});
