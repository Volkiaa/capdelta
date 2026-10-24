import { describe, expect, it } from "vitest";
import { MAX_IDENTITY_CHARS } from "../../core/report-builder.js";
import {
  createReviewers,
  generateToken,
  hashToken,
  parseReviewersFile,
  ReviewersError,
} from "./reviewers.js";

const KEY = hashToken("alice-token");

describe("hashToken", () => {
  it("returns the lowercase sha256 of the token", () => {
    expect(hashToken("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("Reviewers.authenticate", () => {
  it("returns the reviewer for the matching token", () => {
    const reviewers = createReviewers({ [KEY]: "alice" });

    expect(reviewers.authenticate("alice-token")).toBe("alice");
  });

  it("returns null for a token that is not in the file", () => {
    const reviewers = createReviewers({ [KEY]: "alice" });

    expect(reviewers.authenticate("bob-token")).toBeNull();
  });

  it("returns null for a token longer than 200 characters", () => {
    const long = "a".repeat(201);
    const reviewers = createReviewers({ [hashToken(long)]: "alice" });

    expect(reviewers.authenticate(long)).toBeNull();
  });

  it("authenticates a token of exactly 200 characters", () => {
    const token = "a".repeat(200);
    const reviewers = createReviewers({ [hashToken(token)]: "alice" });

    expect(reviewers.authenticate(token)).toBe("alice");
  });

  it("reports the last matching entry when two entries share a token", () => {
    const reviewers = createReviewers({
      [KEY]: "alice",
      [hashToken("bob-token")]: "bob",
    });

    expect(reviewers.authenticate("bob-token")).toBe("bob");
    expect(reviewers.authenticate("alice-token")).toBe("alice");
  });
});

describe("parseReviewersFile", () => {
  it("parses an entry and authenticates its token", () => {
    const reviewers = parseReviewersFile(JSON.stringify({ [KEY]: "alice" }));

    expect(reviewers.authenticate("alice-token")).toBe("alice");
    expect(reviewers.authenticate("other")).toBeNull();
  });

  it("rejects a key that is not 64 lowercase hex characters", () => {
    for (const key of [
      KEY.toUpperCase(),
      KEY.slice(1),
      `${KEY}0`,
      "g".repeat(64),
      "not-a-hash",
    ]) {
      expect(() =>
        parseReviewersFile(JSON.stringify({ [key]: "alice" })),
      ).toThrow(ReviewersError);
    }
  });

  it("names the offending key", () => {
    const key = "not-a-hash";

    expect(() =>
      parseReviewersFile(JSON.stringify({ [key]: "alice" })),
    ).toThrow(key);
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(() => parseReviewersFile(JSON.stringify({ [KEY]: "" }))).toThrow(
      ReviewersError,
    );
    expect(() => parseReviewersFile(JSON.stringify({ [KEY]: "   " }))).toThrow(
      ReviewersError,
    );
  });

  it("rejects the analyzer as a reviewer name in any case", () => {
    for (const name of ["analyzer", "Analyzer", "ANALYZER"]) {
      expect(() => parseReviewersFile(JSON.stringify({ [KEY]: name }))).toThrow(
        ReviewersError,
      );
    }
  });

  it("rejects a name longer than the identity limit", () => {
    const name = "a".repeat(MAX_IDENTITY_CHARS + 1);

    expect(() => parseReviewersFile(JSON.stringify({ [KEY]: name }))).toThrow(
      ReviewersError,
    );
  });

  it("accepts a name at the identity limit", () => {
    const name = "a".repeat(MAX_IDENTITY_CHARS);

    expect(
      parseReviewersFile(JSON.stringify({ [KEY]: name })).authenticate(
        "alice-token",
      ),
    ).toBe(name);
  });

  it("rejects an empty object", () => {
    expect(() => parseReviewersFile("{}")).toThrow(ReviewersError);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseReviewersFile("{")).toThrow(ReviewersError);
  });

  it("rejects JSON that is not an object", () => {
    for (const text of ["[]", "null", "42", '"alice"']) {
      expect(() => parseReviewersFile(text)).toThrow(ReviewersError);
    }
  });

  it("rejects a non-string name", () => {
    expect(() => parseReviewersFile(JSON.stringify({ [KEY]: 7 }))).toThrow(
      ReviewersError,
    );
  });
});

describe("generateToken", () => {
  it("returns a prefixed token with 32 random bytes", () => {
    const token = generateToken();

    expect(token).toMatch(/^cdr_[A-Za-z0-9_-]{43}$/u);
    expect(generateToken()).not.toBe(token);
  });
});
