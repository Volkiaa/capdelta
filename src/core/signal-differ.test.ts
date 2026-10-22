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
  buildSignalSet,
  observeSignalSource,
} from "./signal-extractor.js";
import { collectStringContent, parseSource } from "./npm/javascript-parse.js";
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

  describe("ADR-037: a widened old host never hides a new one", () => {
    function setOf(file: string, text: string): SignalSet {
      const { ast, comments } = parseSource(text, "either");
      return buildSignalSet([
        observeSignalSource({
          file,
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          commentRanges: comments,
          ...collectStringContent(ast, text),
        }),
      ]);
    }

    function addedHosts(
      oldText: string,
      newText: string,
      file = "index.js",
    ): string[] {
      return diffSignals(setOf(file, oldText), setOf(file, newText))
        .filter((finding) => finding.kind === "new-external-endpoint")
        .map((finding) => finding.detail);
    }

    it.each([
      ["a cooked escaped scheme", 'f("h\\u0074tps://a.test b@evil.test/x");'],
      ["a cooked ignored newline", 'f("h\\nttps://a.test b@evil.test/x");'],
      ["an uppercase scheme", 'f("HTTPS://a.test b@evil.test/x");'],
      [
        "a template element",
        'const suffix = ".safe.test";\nf(`HTTPS://a b@evil.test${suffix}`);',
      ],
    ])(
      "reports the new host after %s in the old version",
      (_label, oldText) => {
        expect(addedHosts(oldText, 'f("https://evil.test/x");')).toEqual([
          "new external domain evil.test",
        ]);
      },
    );

    it.each([
      [
        "an underscored label",
        'f("https://a_b.example.test/x");',
        "a_b.example.test",
      ],
      ["a mixed hex/octal IPv4", 'f("https://0x08.010.8.8/x");', "8.8.8.8"],
    ])(
      "keeps main's old %s and still reports the new host",
      (_label, oldText, oldHost) => {
        const newText = `${oldText}\nf("https://evil.test/x");`;
        expect(addedHosts(oldText, newText)).toEqual([
          "new external domain evil.test",
        ]);
        expect(addedHosts(oldText, newText)).not.toContain(
          `new external domain ${oldHost}`,
        );
      },
    );

    it("reports a new host in an .mts file that main already scans", () => {
      expect(
        addedHosts(
          'f("https://a.example.test/x");',
          'f("https://a.example.test/x");\nf("https://evil.test/x");',
          "index.mts",
        ),
      ).toEqual(["new external domain evil.test"]);
    });

    it("reports the new host after 130,000 repeated cooked URLs", () => {
      const repeated = "http://a.co ".repeat(130_000);
      const oldText = `f("${repeated.replace(" ", "\\x20")}");`;
      expect(
        addedHosts(oldText, `${oldText}\nf("https://evil.test/x");`),
      ).toEqual(["new external domain evil.test"]);
    });
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
