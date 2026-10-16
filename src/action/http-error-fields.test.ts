import { describe, expect, it } from "vitest";
import { httpMessageOf, httpStatusOf } from "./http-error-fields.js";

describe("httpStatusOf", () => {
  it("reads a number status", () => {
    expect(httpStatusOf({ status: 403 })).toBe(403);
  });

  it("returns null for a string status", () => {
    expect(httpStatusOf({ status: "403" })).toBe(null);
  });

  it("returns null when status is missing", () => {
    expect(httpStatusOf({ message: "missing" })).toBe(null);
  });

  it("returns null for null", () => {
    expect(httpStatusOf(null)).toBe(null);
  });

  it("returns null for a non-object", () => {
    expect(httpStatusOf("403")).toBe(null);
  });
});

describe("httpMessageOf", () => {
  it("reads a string message", () => {
    expect(httpMessageOf({ message: "denied" })).toBe("denied");
  });

  it("returns null for a non-string message", () => {
    expect(httpMessageOf({ message: 403 })).toBe(null);
  });

  it("returns null when message is missing", () => {
    expect(httpMessageOf({ status: 403 })).toBe(null);
  });

  it("returns null for null", () => {
    expect(httpMessageOf(null)).toBe(null);
  });

  it("returns null for a non-object", () => {
    expect(httpMessageOf("denied")).toBe(null);
  });
});
