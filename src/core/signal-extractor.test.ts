import { describe, expect, it } from "vitest";
import {
  MIN_OBFUSCATION_ARRAY_ELEMENTS,
  buildSignalSet,
  observeSignalSource,
} from "./signal-extractor.js";

function source(
  file: string,
  text: string,
  parseState:
    "parsed" | "unparseable" | "unsupported" | "unreadable" = "parsed",
) {
  return observeSignalSource({
    file,
    bytes: new TextEncoder().encode(text),
    parseState,
  });
}

describe("signal extractor", () => {
  it("normalizes external domains and detects public IP literals", () => {
    const result = buildSignalSet([
      source(
        "index.js",
        [
          "fetch('https://API.Example.COM/path');",
          "const remote = '203.0.113.10';",
          "const local = 'http://127.0.0.1';",
          "const privateIp = '192.168.1.2';",
        ].join("\n"),
      ),
    ]);

    expect(
      result.endpoints.map((item) => [item.endpointType, item.normalizedValue]),
    ).toEqual([
      ["domain", "api.example.com"],
      ["ipv4", "203.0.113.10"],
    ]);
    expect(
      result.endpoints.find((item) => item.endpointType === "ipv4")
        ?.evidence[0],
    ).toMatchObject({
      file: "index.js",
      line: 2,
    });
  });

  it("extracts IPv6 literals and uses byte-scan confidence for rejected files", () => {
    const result = buildSignalSet([
      source(
        "broken.js",
        "connect('https://[2001:db8::10]/x');",
        "unparseable",
      ),
    ]);

    expect(result.endpoints).toContainEqual(
      expect.objectContaining({
        endpointType: "ipv6",
        normalizedValue: "2001:db8::10",
        confidence: "byte-scan-candidate",
      }),
    );
  });

  it("records entropy and detects both bounded obfuscation array shapes", () => {
    const hex = Array.from(
      { length: MIN_OBFUSCATION_ARRAY_ELEMENTS },
      (_, index) => `0x${index.toString(16).padStart(2, "0")}`,
    ).join(",");
    const chars = Array.from(
      { length: MIN_OBFUSCATION_ARRAY_ELEMENTS },
      (_, index) => String(65 + index),
    ).join(",");
    const result = buildSignalSet([
      source("payload.js", `const a=[${hex}]; const b=[${chars}];`),
    ]);

    expect(result.sourceFiles[0]).toMatchObject({
      file: "payload.js",
      byteLength: 85,
      parseState: "parsed",
    });
    expect(result.sourceFiles[0]?.entropyMilliBitsPerByte).toBeGreaterThan(0);
    expect(result.obfuscationPatterns.map((item) => item.pattern)).toEqual([
      "charcode-array",
      "hex-byte-array",
    ]);
    expect(
      result.obfuscationPatterns.every((item) => item.file === "payload.js"),
    ).toBe(true);
  });

  it("retains unreadable files as signal data instead of dropping them", () => {
    const result = buildSignalSet([
      observeSignalSource({
        file: "bytes.js",
        bytes: Uint8Array.from([0xff, 0xfe, 0xfd]),
        parseState: "unreadable",
      }),
    ]);

    expect(result.sourceFiles).toEqual([
      {
        file: "bytes.js",
        byteLength: 3,
        entropyMilliBitsPerByte: 1585,
        parseState: "unreadable",
      },
    ]);
  });
});
