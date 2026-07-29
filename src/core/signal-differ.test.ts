import { describe, expect, it } from "vitest";
import type { SignalSet } from "./contract/capability-set.js";
import {
  ENTROPY_JUMP_MILLIBITS,
  HIGH_ENTROPY_MILLIBITS,
  MIN_ENTROPY_BYTES,
} from "./signal-extractor.js";
import { diffSignals } from "./signal-differ.js";

const evidence = [{ file: "index.js", line: 1, snippet: "signal" }] as const;

function set(overrides: Partial<SignalSet> = {}): SignalSet {
  return {
    sourceFiles: [],
    endpoints: [],
    obfuscationPatterns: [],
    ...overrides,
  };
}

describe("signal differ", () => {
  it("reports only newly introduced endpoints and obfuscation patterns", () => {
    const endpoint = {
      kind: "EXTERNAL_ENDPOINT" as const,
      endpointType: "domain" as const,
      normalizedValue: "new.example.com",
      confidence: "literal" as const,
      evidence,
    };
    const pattern = {
      kind: "OBFUSCATION_PATTERN" as const,
      file: "index.js",
      pattern: "hex-byte-array" as const,
      elementCount: 12,
      evidence,
    };
    const result = diffSignals(
      set({ endpoints: [endpoint], obfuscationPatterns: [pattern] }),
      set({
        endpoints: [
          endpoint,
          { ...endpoint, normalizedValue: "old.example.com" },
        ],
        obfuscationPatterns: [pattern],
      }),
    );

    expect(result).toEqual([
      {
        kind: "new-external-endpoint",
        severity: "HIGH",
        change: "added",
        detail: "new external domain old.example.com",
        evidence,
      },
    ]);
  });

  it("reports entropy jumps and aggregate unparseable-byte growth", () => {
    const oldBytes = MIN_ENTROPY_BYTES;
    const newBytes = oldBytes + 50;
    const result = diffSignals(
      set({
        sourceFiles: [
          {
            file: "blob.js",
            byteLength: oldBytes,
            entropyMilliBitsPerByte:
              HIGH_ENTROPY_MILLIBITS - ENTROPY_JUMP_MILLIBITS,
            parseState: "parsed",
          },
        ],
      }),
      set({
        sourceFiles: [
          {
            file: "blob.js",
            byteLength: newBytes,
            entropyMilliBitsPerByte: HIGH_ENTROPY_MILLIBITS,
            parseState: "unparseable",
          },
        ],
      }),
    );

    expect(result.map((finding) => finding.kind)).toEqual([
      "entropy-jump",
      "unparseable-bytes-growth",
      "unparseable-file",
    ]);
    expect(result.every((finding) => finding.severity === "MEDIUM")).toBe(true);
  });

  it("does not repeat unchanged unparseable files or entropy", () => {
    const file = {
      file: "same.js",
      byteLength: 300,
      entropyMilliBitsPerByte: 7_000,
      parseState: "unparseable" as const,
    };
    expect(
      diffSignals(set({ sourceFiles: [file] }), set({ sourceFiles: [file] })),
    ).toEqual([]);
  });
});
