import { describe, expect, it } from "vitest";
import { errorName, isAbortSignal, isRecord } from "./guards.js";

class WidgetError extends Error {
  constructor() {
    super("boom");
    this.name = "WidgetError";
  }
}

describe("isRecord", () => {
  it("rejects an array", () => {
    expect(isRecord([])).toBe(false);
  });

  it("rejects null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("accepts a plain object", () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects a primitive", () => {
    expect(isRecord("value")).toBe(false);
  });
});

describe("isAbortSignal", () => {
  it("accepts a real AbortSignal", () => {
    expect(isAbortSignal(new AbortController().signal)).toBe(true);
  });

  it("rejects an object with aborted and addEventListener but no removeEventListener", () => {
    expect(
      isAbortSignal({ aborted: false, addEventListener: () => undefined }),
    ).toBe(false);
  });
});

describe("errorName", () => {
  it("returns the name of an Error subclass", () => {
    expect(errorName(new WidgetError())).toBe("WidgetError");
  });

  it("returns the type of a thrown string", () => {
    expect(errorName("boom")).toBe("string");
  });
});
