import { describe, expect, it } from "vitest";
import type {
  SignalEndpointContext,
  SignalEndpointObservation,
  SignalSet,
} from "./contract/capability-set.js";
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

function endpointWith(
  context: SignalEndpointContext,
  value: string,
  provenance: SignalEndpointObservation["provenance"] = "established",
) {
  return {
    kind: "EXTERNAL_ENDPOINT" as const,
    endpointType: "domain" as const,
    normalizedValue: value,
    confidence: "literal" as const,
    context,
    provenance,
    evidence,
  };
}

describe("signal differ", () => {
  it("reports only newly introduced endpoints and obfuscation patterns", () => {
    const endpoint = {
      kind: "EXTERNAL_ENDPOINT" as const,
      endpointType: "domain" as const,
      normalizedValue: "new.example.com",
      confidence: "literal" as const,
      context: "literal" as const,
      provenance: "established" as const,
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

  it("reports a new host mentioned only in text at LOW", () => {
    const result = diffSignals(
      set(),
      set({ endpoints: [endpointWith("embedded-text", "docs.example.test")] }),
    );

    expect(result).toEqual([
      {
        kind: "new-external-endpoint",
        severity: "LOW",
        change: "added",
        detail: "new external domain docs.example.test (mentioned in text)",
        evidence,
      },
    ]);
  });

  it("names the longer string for an IPv6 host mentioned in text", () => {
    const endpoint = {
      ...endpointWith("embedded-text", "2001:db8::1"),
      endpointType: "ipv6" as const,
    };
    const result = diffSignals(set(), set({ endpoints: [endpoint] }));

    expect(result).toEqual([
      {
        kind: "new-external-endpoint",
        severity: "LOW",
        change: "added",
        detail: "new external ipv6 2001:db8::1 (inside a longer string)",
        evidence,
      },
    ]);
  });

  it.each(["literal", "unknown"] as const)(
    "keeps a new host with %s context at HIGH",
    (context) => {
      const result = diffSignals(
        set(),
        set({ endpoints: [endpointWith(context, "api.example.test")] }),
      );

      expect(result).toEqual([
        expect.objectContaining({
          severity: "HIGH",
          detail: "new external domain api.example.test",
        }),
      ]);
    },
  );

  it("does not report a host that the old side already mentions in text", () => {
    const endpoint = endpointWith("embedded-text", "docs.example.test");
    expect(
      diffSignals(
        set({ endpoints: [endpoint] }),
        set({ endpoints: [endpoint] }),
      ),
    ).toEqual([]);
  });

  it("reports an established host that the old side only has as additive", () => {
    const result = diffSignals(
      set({
        endpoints: [endpointWith("literal", "api.example.test", "additive")],
      }),
      set({
        endpoints: [endpointWith("literal", "api.example.test", "established")],
      }),
    );

    expect(result).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        detail: "new external domain api.example.test",
      }),
    ]);
  });

  it("does not report an additive host that the old side has as established", () => {
    const result = diffSignals(
      set({
        endpoints: [endpointWith("literal", "api.example.test", "established")],
      }),
      set({
        endpoints: [endpointWith("literal", "api.example.test", "additive")],
      }),
    );

    expect(result).toEqual([]);
  });

  it("does not report an additive host that the old side also only has as additive", () => {
    const result = diffSignals(
      set({
        endpoints: [endpointWith("literal", "api.example.test", "additive")],
      }),
      set({
        endpoints: [endpointWith("literal", "api.example.test", "additive")],
      }),
    );

    expect(result).toEqual([]);
  });

  it("does not report an established host that the old side also has as established", () => {
    const result = diffSignals(
      set({
        endpoints: [endpointWith("literal", "api.example.test", "established")],
      }),
      set({
        endpoints: [endpointWith("literal", "api.example.test", "established")],
      }),
    );

    expect(result).toEqual([]);
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

describe("import-time unbounded loop signal", () => {
  const looping = {
    file: "index.js",
    byteLength: 120,
    entropyMilliBitsPerByte: 4_000,
    parseState: "parsed" as const,
    topLevelLoop: { line: 7 },
  };

  it("reports a new module-scope endless loop at MEDIUM", () => {
    const result = diffSignals(set(), set({ sourceFiles: [looping] }));

    expect(result).toEqual([
      {
        kind: "import-time-unbounded-loop",
        severity: "MEDIUM",
        change: "added",
        detail: "index.js has an unbounded loop at module scope (line 7)",
        evidence: [{ file: "index.js", line: 7, snippet: "" }],
      },
    ]);
  });

  it("does not report a loop the old side already had", () => {
    expect(
      diffSignals(
        set({ sourceFiles: [looping] }),
        set({ sourceFiles: [looping] }),
      ),
    ).toEqual([]);
  });

  it("does not report a file without the flag", () => {
    expect(
      diffSignals(
        set(),
        set({
          sourceFiles: [
            {
              file: "index.js",
              byteLength: 120,
              entropyMilliBitsPerByte: 4_000,
              parseState: "parsed",
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
