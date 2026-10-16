import { describe, expect, it } from "vitest";
import { describeLockfileVersion } from "./errors.js";

describe("describeLockfileVersion", () => {
  it("renders a number as its JSON value", () => {
    expect(describeLockfileVersion(1)).toBe("1");
  });

  it("renders a string quoted", () => {
    expect(describeLockfileVersion("2")).toBe('"2"');
  });

  it("renders an object as its typeof", () => {
    expect(describeLockfileVersion({ lockfileVersion: 4 })).toBe("<object>");
  });

  it("renders undefined as its typeof", () => {
    expect(describeLockfileVersion(undefined)).toBe("<undefined>");
  });
});
