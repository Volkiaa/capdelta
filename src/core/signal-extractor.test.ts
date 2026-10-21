import { describe, expect, it } from "vitest";
import {
  MIN_OBFUSCATION_ARRAY_ELEMENTS,
  type SignalSourceInput,
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

  it("merges one IPv6 literal written in two cases across lines", () => {
    const result = buildSignalSet([
      source(
        "index.js",
        ["const a = '2001:DB8::1';", "const b = '2001:db8::1';"].join("\n"),
      ),
    ]);

    const ipv6 = result.endpoints.filter(
      (item) => item.endpointType === "ipv6",
    );
    expect(ipv6).toHaveLength(1);
    expect(ipv6[0]?.normalizedValue).toBe("2001:db8::1");
    expect(ipv6[0]?.evidence.map((item) => item.line)).toEqual([1, 2]);
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

  describe("endpoint noise controls", () => {
    const hosts = (text: string, state: "parsed" | "unparseable" = "parsed") =>
      buildSignalSet([source("index.js", text, state)]).endpoints.map(
        (item) => item.normalizedValue,
      );

    it.each([
      ["a template placeholder", "x = 'http://$addr/';"],
      ["a single-label host", "x = 'https://@fs/path';"],
      ["an underscore label", "x = 'https://a_b.example.com/';"],
      ["a numeric TLD", "x = 'https://example.123/';"],
      ["a bare punycode TLD", "x = 'https://example.xn--/';"],
      ["an oversized domain", `x = 'https://${"a.".repeat(130)}com/';`],
    ])("drops %s", (_label, text) => {
      expect(hosts(text)).toEqual([]);
    });

    it.each([
      [
        "markdown trailing parenthesis",
        "x = '[u](http://underscorejs.org)';",
        "underscorejs.org",
      ],
      [
        "port and credentials",
        "x = 'https://user:pw@api.example.com:8443/';",
        "api.example.com",
      ],
      ["root dot", "x = 'https://api.example.com./';", "api.example.com"],
      [
        "punycode",
        "x = 'https://xn--bcher-kva.example/';",
        "xn--bcher-kva.example",
      ],
      [
        "IDN converted by URL",
        "x = 'https://bücher.example/';",
        "xn--bcher-kva.example",
      ],
      [
        "reserved test TLD",
        "x = 'https://c2.example.test/';",
        "c2.example.test",
      ],
    ])("keeps %s", (_label, text, expected) => {
      expect(hosts(text)).toEqual([expected]);
    });

    it("leaves IP classification unchanged by the domain heuristic", () => {
      expect(
        hosts(
          "a = 'http://203.0.113.9/'; b = 'https://[2001:db8::7]/'; c = 'http://10.0.0.1';",
        ),
      ).toEqual(["203.0.113.9", "2001:db8::7"]);
    });

    it("skips endpoints inside parser comment ranges, only for parsed sources", () => {
      const text =
        "// https://docs.example.org\nfetch('https://api.example.net');\n";
      const ranges = [[0, 27]] as const;
      const observe = (parseState: "parsed" | "unparseable") =>
        buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(text),
            parseState,
            commentRanges: ranges,
          }),
        ]).endpoints.map((item) => item.normalizedValue);
      expect(observe("parsed")).toEqual(["api.example.net"]);
      expect(observe("unparseable")).toEqual([
        "api.example.net",
        "docs.example.org",
      ]);
    });

    it.each([
      [
        "overlapping",
        [
          [0, 5],
          [3, 8],
        ],
      ],
      ["empty", [[4, 4]]],
      ["out of bounds", [[0, 999]]],
      ["non-integer", [[0.5, 3]]],
    ] as const)("rejects %s comment ranges loudly", (_label, ranges) => {
      expect(() =>
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode("const x = 1; // comment\n"),
          parseState: "parsed",
          commentRanges: ranges,
        }),
      ).toThrow(RangeError);
    });
    const invalidStringRanges: [string, unknown][] = [
      ["a non-boolean flag", [[4, 9, "yes"]]],
      ["a missing flag", [[4, 9]]],
      [
        "an overlapping range",
        [
          [0, 5, false],
          [3, 8, false],
        ],
      ],
    ];
    it.each(invalidStringRanges)(
      "rejects %s in string ranges loudly",
      (_label, ranges) => {
        expect(() =>
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(
              "fetch('https://api.example.net');\n",
            ),
            parseState: "parsed",
            stringRanges: ranges as NonNullable<
              SignalSourceInput["stringRanges"]
            >,
          }),
        ).toThrow(RangeError);
      },
    );
  });
});

describe("signal aggregation", () => {
  it("keeps literal confidence whichever file is seen first", () => {
    const literal = source("a.js", 'f("https://evil.test/x");', "parsed");
    const scanned = source("b.js", 'f("https://evil.test/x");', "unparseable");

    for (const order of [
      [literal, scanned],
      [scanned, literal],
    ]) {
      expect(buildSignalSet(order).endpoints).toMatchObject([
        { normalizedValue: "evil.test", confidence: "literal" },
      ]);
    }
  });

  it("builds evidence for many matches on one long line in linear time", () => {
    const text = 'f("https://evil.test/x");'.repeat(64_000);

    const started = performance.now();
    const [endpoint] = buildSignalSet([
      source("a.js", text, "unparseable"),
    ]).endpoints;

    expect(endpoint?.evidence).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("merges thousands of matches for one host in linear time", () => {
    const text = Array.from(
      { length: 20_000 },
      () => 'f("https://evil.test/x");',
    ).join("\n");

    const started = performance.now();
    const [endpoint] = buildSignalSet([
      source("a.js", text, "unparseable"),
    ]).endpoints;

    expect(endpoint?.normalizedValue).toBe("evil.test");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
