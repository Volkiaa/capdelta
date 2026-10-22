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

  it("merges an established and an additive observation of one host to established", () => {
    const observed = source("index.js", "fetch('https://api.example.test');");
    const endpoint = observed.endpoints[0];
    if (endpoint === undefined) throw new Error("no endpoint observed");
    const additive = {
      ...observed,
      file: { ...observed.file, file: "widened.js" },
      endpoints: [{ ...endpoint, provenance: "additive" as const }],
    };

    const result = buildSignalSet([additive, observed]);

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]?.provenance).toBe("established");
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
      ["a placeholder in a label", "x = 'https://a$b.example.com/';"],
      ["a single-label host", "x = 'https://@fs/path';"],
      ["an underscore in the TLD", "x = 'https://example.co_m/';"],
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
      [
        "an underscore label",
        "x = 'https://a_b.example.com/';",
        "a_b.example.com",
      ],
      [
        "an underscore at the start of a label",
        "x = 'https://_dmarc.example.com/';",
        "_dmarc.example.com",
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

  describe("hex and octal dotted IPv4 (ADR-031)", () => {
    const hosts = (text: string) =>
      buildSignalSet([source("index.js", text)])
        .endpoints.filter((item) => item.endpointType === "ipv4")
        .map((item) => item.normalizedValue);

    it.each([
      ["93.0xb8.216.34", "93.184.216.34"],
      ["0135.0270.0330.042", "93.184.216.34"],
      ["93.184.216.034", "93.184.216.28"],
    ])("reports %s as %s", (text, expected) => {
      expect(hosts(`connect(443, "${text}");`)).toEqual([expected]);
    });

    it.each([
      [
        "a four-digit octal part with leading zeros",
        "93.184.216.0000034",
        "93.184.216.28",
      ],
      [
        "a long run of leading zeros in an octal part",
        "93.184.216.00000000000000000042",
        "93.184.216.34",
      ],
      [
        "a long run of zeros in a hex part",
        "0x0000005d.184.216.34",
        "93.184.216.34",
      ],
      [
        "leading zeros in a trailing hex part",
        "93.184.216.0x00022",
        "93.184.216.34",
      ],
    ])("reports leading zeros in %s as %s", (_label, text, expected) => {
      expect(hosts(`connect(443, "${text}");`)).toEqual([expected]);
    });

    it("drops a private address written with a hex part", () => {
      expect(hosts('connect(443, "10.0x0.0.1");')).toEqual([]);
    });

    it.each([
      ["three parts", "1.2.3"],
      ["a single decimal number", "1572395042"],
      ["a single hex number", "0x5db8d822"],
      ["three octal-looking parts", "01.02.03"],
      ["a hex part with a non-hex digit", "0x1g.1.1.1"],
      ["an octal part over one byte", "0400.1.1.1"],
      ["an octal part over one byte with four digits", "93.184.216.0400"],
      ["a hex part over one byte", "93.184.216.0x100"],
    ])("drops %s", (_label, text) => {
      expect(hosts(`connect(443, "${text}");`)).toEqual([]);
    });

    it("stays fast on a long run of zeros between dots", () => {
      const text = `connect(443, "1.${"0".repeat(100_000)}.1.1");`;
      const started = performance.now();
      expect(hosts(text)).toEqual(["1.0.1.1"]);
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it("keeps a canonical dotted decimal observation unchanged", () => {
      expect(
        buildSignalSet([source("index.js", 'connect(443, "93.184.216.34");')])
          .endpoints,
      ).toEqual([
        expect.objectContaining({
          endpointType: "ipv4",
          normalizedValue: "93.184.216.34",
          context: "unknown",
          confidence: "literal",
        }),
      ]);
    });

    it("reports a URL with a hex part once with the canonical value", () => {
      expect(hosts('fetch("http://93.0xb8.216.34/x");')).toEqual([
        "93.184.216.34",
      ]);
    });

    it("skips a non-canonical address inside a parser comment range", () => {
      const text = '// connect(443, "93.0xb8.216.34")\n';
      expect(
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          commentRanges: [[0, text.length]],
        }).endpoints,
      ).toEqual([]);
    });
  });

  describe("endpoint URLs whose userinfo holds a stop character", () => {
    const endpointsOf = (value: string) => {
      const text = `f("${value}");`;
      const content = text.indexOf('"') + 1;
      return buildSignalSet([
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          stringRanges: [
            [content, text.lastIndexOf('"'), /\s/u.test(value.trim())],
          ],
        }),
      ]).endpoints.map((item) => ({
        host: item.normalizedValue,
        context: item.context,
      }));
    };

    it.each([
      ["a space", "https://a b@exfil.example.test/x"],
      ["an apostrophe", "https://a'b@exfil.example.test/x"],
      ["a less-than sign", "https://a<b@exfil.example.test/x"],
      ["a greater-than sign", "https://a>b@exfil.example.test/x"],
      ["a backtick", "https://a`b@exfil.example.test/x"],
    ])("reports the host after userinfo containing %s", (_label, value) => {
      expect(endpointsOf(value)).toEqual([
        { host: "exfil.example.test", context: "literal" },
      ]);
    });

    it("keeps the host main reports before the userinfo host", () => {
      expect(endpointsOf("https://a.test b@evil.test/x")).toEqual([
        { host: "a.test", context: "literal" },
        { host: "evil.test", context: "literal" },
      ]);
    });

    it.each([
      [
        "with a lowercase scheme",
        'f("https://a.test b@evil.test/x");',
        [
          ["a.test", "established"],
          ["evil.test", "additive"],
        ],
      ],
      [
        "with an uppercase scheme",
        'f("HTTPS://a.test b@evil.test/x");',
        [["evil.test", "additive"]],
      ],
    ])(
      "tags only the widened host as additive %s",
      (_label, text, expected) => {
        const start = text.indexOf('"') + 1;
        const end = text.lastIndexOf('"');
        expect(
          buildSignalSet([
            observeSignalSource({
              file: "index.js",
              bytes: new TextEncoder().encode(text),
              parseState: "parsed",
              stringRanges: [[start, end, /\s/u.test(text.slice(start, end))]],
            }),
          ]).endpoints.map((item) => [item.normalizedValue, item.provenance]),
        ).toEqual(expected);
      },
    );

    it("keeps main's context on the established observation", () => {
      const text = 'f("https://a.test b@evil.test/x");';
      const start = text.indexOf('"') + 1;
      const end = text.lastIndexOf('"');
      expect(
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          stringRanges: [[start, end, true]],
        }).endpoints.map((item) => [
          item.normalizedValue,
          item.context,
          item.provenance,
        ]),
      ).toEqual([
        ["a.test", "embedded-text", "established"],
        ["a.test", "literal", "additive"],
        ["evil.test", "literal", "additive"],
      ]);
    });

    it.each(["HTTPS", "hTtPs", "HTTP", "WsS", "WS"])(
      "reports the runtime host for raw %s userinfo URLs",
      (scheme) => {
        expect(endpointsOf(`${scheme}://a.test b@evil.test/x`)).toEqual([
          { host: "evil.test", context: "literal" },
        ]);
      },
    );

    it.each([
      "see HTTPS://a.test b@evil.test/x",
      "HTTPS://a.test b@evil.test\u00a0",
      "HTTPS://a.test/x b@evil.test",
    ])("does not invent a host from uppercase text %j", (value) => {
      expect(endpointsOf(value)).toEqual([]);
    });

    it("keeps the lowercase URL inside an uppercase URL path", () => {
      expect(endpointsOf("HTTPS://outer.test/https://inner.test/x")).toEqual([
        { host: "inner.test", context: "literal" },
      ]);
    });

    it("keeps prose around a URL embedded and at its current host", () => {
      expect(
        endpointsOf("https://a.example.test/x see b@c.example.test"),
      ).toEqual([{ host: "a.example.test", context: "embedded-text" }]);
    });

    it("does not report a userinfo URL written in a comment", () => {
      const comment = "// https://a b@exfil.example.test/x";
      const text = `${comment}\nf("https://api.example.test/x");`;
      expect(
        buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(text),
            parseState: "parsed",
            commentRanges: [[0, comment.length]],
          }),
        ]).endpoints.map((item) => item.normalizedValue),
      ).toEqual(["api.example.test"]);
    });

    it("reports no partial host when a template element ends at an expression", () => {
      const text = "f(`https://a b@${x}`);";
      const content = text.indexOf("`") + 1;
      expect(
        buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(text),
            parseState: "parsed",
            stringRanges: [[content, text.indexOf("${"), true]],
          }),
        ]).endpoints,
      ).toEqual([]);
    });

    it("reports the host after a userinfo space written as an escape", () => {
      const raw = 'f("https://a\\x20b@exfil.example.test/x");';
      const start = raw.indexOf('"') + 1;
      const end = raw.lastIndexOf('"');
      expect(
        buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(raw),
            parseState: "parsed",
            stringRanges: [[start, end, true]],
            cookedStrings: [[start, "https://a b@exfil.example.test/x"]],
          }),
        ]).endpoints.map((item) => ({
          host: item.normalizedValue,
          context: item.context,
        })),
      ).toEqual([{ host: "exfil.example.test", context: "literal" }]);
    });

    describe("cooked values whose userinfo hides a host", () => {
      const endpointsOfCooked = (raw: string, cooked: string) => {
        const start = raw.indexOf('"') + 1;
        const end = raw.lastIndexOf('"');
        return buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(raw),
            parseState: "parsed",
            stringRanges: [[start, end, /\s/u.test(cooked)]],
            cookedStrings: [[start, cooked]],
          }),
        ]).endpoints.map((item) => ({
          host: item.normalizedValue,
          context: item.context,
        }));
      };

      it("keeps the host main finds when the scheme is escaped", () => {
        // The literal scan cannot see "h\u0074tps", so a.test is only in the
        // cooked scan. Reporting the userinfo host instead would drop it.
        expect(
          endpointsOfCooked(
            'f("h\\u0074tps://a.test b@evil.test/x");',
            "https://a.test b@evil.test/x",
          ),
        ).toEqual([
          { host: "a.test", context: "literal" },
          { host: "evil.test", context: "literal" },
        ]);
      });

      it.each(["HTTPS", "hTtPs", "HTTP", "WsS", "WS"])(
        "reports the runtime host for cooked %s userinfo URLs",
        (scheme) => {
          expect(
            endpointsOfCooked(
              `f("\\u${scheme.charCodeAt(0).toString(16).padStart(4, "0")}${scheme.slice(1)}://a.test\\x20b@evil.test/x");`,
              `${scheme}://a.test b@evil.test/x`,
            ),
          ).toEqual([{ host: "evil.test", context: "literal" }]);
        },
      );

      it.each([
        "see HTTPS://a.test b@evil.test/x",
        "HTTPS://a.test b@evil.test\u00a0",
        "HTTPS://a.test/x b@evil.test",
      ])("does not invent a cooked host from uppercase text %j", (value) => {
        expect(
          endpointsOfCooked(`f(${JSON.stringify(value)});`, value),
        ).toEqual([]);
      });

      it("keeps a cooked lowercase URL inside an uppercase URL path", () => {
        expect(
          endpointsOfCooked(
            'f("HTTPS://outer.test/https://inner.test/\\x78");',
            "HTTPS://outer.test/https://inner.test/x",
          ),
        ).toEqual([{ host: "inner.test", context: "literal" }]);
      });

      it.each(["\n", "\t", "\r"])(
        "adds the runtime host when the scheme contains %j",
        (ignored) => {
          expect(
            endpointsOfCooked(
              `f(${JSON.stringify(`h${ignored}ttps://a.example.test b@evil.example.test/x`)});`,
              `h${ignored}ttps://a.example.test b@evil.example.test/x`,
            ),
          ).toEqual([
            { host: "a.example.test", context: "literal" },
            { host: "evil.example.test", context: "literal" },
          ]);
        },
      );

      it.each(["\u00a0", "\u2028"])(
        "does not invent a runtime host by trimming Unicode whitespace %j",
        (suffix) => {
          const cooked = `https://a.example.test b@evil.example.test${suffix}`;
          expect(
            endpointsOfCooked(`f(${JSON.stringify(cooked)});`, cooked),
          ).toEqual([{ host: "a.example.test", context: "embedded-text" }]);
        },
      );

      it("appends input-sized cooked observations without argument spreading", () => {
        const cooked = "http://a.co ".repeat(130_000);
        const raw = `f("${cooked.replace(" ", "\\x20")}");`;
        expect(endpointsOfCooked(raw, cooked)).toEqual([
          { host: "a.co", context: "embedded-text" },
        ]);
      });

      it("keeps every host a cooked value reports around the userinfo URL", () => {
        expect(
          endpointsOfCooked(
            'f("h\\u0074tps://a.test b@evil.test/x https://c.test/y");',
            "https://a.test b@evil.test/x https://c.test/y",
          ),
        ).toEqual([
          { host: "a.test", context: "literal" },
          { host: "c.test", context: "literal" },
          { host: "evil.test", context: "literal" },
        ]);
      });

      it("keeps the host both scans find when the space is escaped", () => {
        expect(
          endpointsOfCooked(
            'f("https://a.test\\x20b@evil.test/x");',
            "https://a.test b@evil.test/x",
          ),
        ).toEqual([
          { host: "a.test", context: "literal" },
          { host: "evil.test", context: "literal" },
        ]);
      });
    });
  });

  describe("cooked string values (ADR-026)", () => {
    const text = 'fetch("https://plain.test/x");';
    const start = text.indexOf('"') + 1;
    const end = text.lastIndexOf('"');
    const ranges = [[start, end, false]] as const;
    const observe = (
      cookedStrings?: NonNullable<SignalSourceInput["cookedStrings"]>,
    ) =>
      observeSignalSource({
        file: "index.js",
        bytes: new TextEncoder().encode(text),
        parseState: "parsed",
        stringRanges: ranges,
        ...(cookedStrings === undefined ? {} : { cookedStrings }),
      });

    it("adds no observation to a string without a backslash", () => {
      const withoutCooked = observe();
      const withEmptyCooked = observe([]);
      expect(withEmptyCooked.endpoints).toEqual(withoutCooked.endpoints);
      expect(withEmptyCooked.endpoints).toHaveLength(1);
    });

    it.each([
      [
        "a start that is not a string range start",
        [[start + 1, "https://x"]],
        ranges,
      ],
      [
        "a value longer than its range",
        [[start, "x".repeat(end - start + 1)]],
        ranges,
      ],
      [
        "entries that are not in ascending order",
        [
          [start, "https://a.test"],
          [start, "https://b.test"],
        ],
        ranges,
      ],
    ] as const)("rejects %s loudly", (_label, cookedStrings, stringRanges) => {
      expect(() =>
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          stringRanges,
          cookedStrings,
        }),
      ).toThrow(RangeError);
    });

    it("does not report a URL found inside a query in a cooked value", () => {
      const raw = 'f("https:\\/\\/?x=https:\\/\\/evil.test");';
      const rawStart = raw.indexOf('"') + 1;
      const rawEnd = raw.lastIndexOf('"');

      expect(
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(raw),
          parseState: "parsed",
          stringRanges: [[rawStart, rawEnd, false]],
          cookedStrings: [[rawStart, "https://?x=https://evil.test"]],
        }).endpoints,
      ).toEqual([]);
    });

    it("rejects a cooked host followed by a control character", () => {
      const raw = 'f("https:\\/\\/evil.test\\u0001?x");';
      const rawStart = raw.indexOf('"') + 1;
      const rawEnd = raw.lastIndexOf('"');

      expect(
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(raw),
          parseState: "parsed",
          stringRanges: [[rawStart, rawEnd, false]],
          cookedStrings: [[rawStart, "https://evil.test\u0001?x"]],
        }).endpoints,
      ).toEqual([]);
    });

    it("merges 4,000 escaped URLs for one host without quadratic work", () => {
      const lineCount = 4_000;
      const line = '"\\x20https://evil.test/x";';
      const sourceText = Array.from({ length: lineCount }, () => line).join(
        "\n",
      );
      const stringRanges: [number, number, boolean][] = [];
      const cookedStrings: [number, string][] = [];
      for (let index = 0; index < lineCount; index += 1) {
        const lineStart = index * (line.length + 1);
        const rangeStart = lineStart + 1;
        const rangeEnd = lineStart + line.length - 1;
        stringRanges.push([rangeStart, rangeEnd, false]);
        cookedStrings.push([rangeStart, " https://evil.test/x"]);
      }

      const result = buildSignalSet([
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(sourceText),
          parseState: "parsed",
          stringRanges,
          cookedStrings,
        }),
      ]);

      expect(result.endpoints).toHaveLength(1);
      expect(result.endpoints[0]).toMatchObject({
        normalizedValue: "evil.test",
        context: "literal",
      });
      expect(result.endpoints[0]?.evidence).toHaveLength(lineCount);
    });
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

  it("classifies many URLs in one parsed string in linear time", () => {
    const text = `f("${"https://evil.test/x ".repeat(64_000)}");`;
    const content = text.indexOf('"') + 1;

    const started = performance.now();
    const [endpoint] = buildSignalSet([
      observeSignalSource({
        file: "a.js",
        bytes: new TextEncoder().encode(text),
        parseState: "parsed",
        stringRanges: [[content, text.lastIndexOf('"'), true]],
      }),
    ]).endpoints;

    expect(endpoint?.context).toBe("embedded-text");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("classifies many IPv6 matches in one parsed string in linear time", () => {
    const text = `f("${"prefix =c::9bb~ ".repeat(64_000)}");`;
    const content = text.indexOf('"') + 1;

    const started = performance.now();
    const [endpoint] = buildSignalSet([
      observeSignalSource({
        file: "a.js",
        bytes: new TextEncoder().encode(text),
        parseState: "parsed",
        stringRanges: [[content, text.lastIndexOf('"'), true]],
      }),
    ]).endpoints;

    expect(endpoint?.context).toBe("embedded-text");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("scans a template of many joined URL elements in linear time", () => {
    const element = "https://evil.test/${x}";
    const body = element.repeat(16_000);
    const ranges: [number, number, boolean][] = [];
    const open = "f(`".length;
    for (let i = 0; i < 16_000; i += 1) {
      const start = open + i * element.length;
      ranges.push([start, start + "https://evil.test/".length, false]);
    }
    const text = `f(\`${body}\`);`;

    const started = performance.now();
    const [endpoint] = buildSignalSet([
      observeSignalSource({
        file: "a.js",
        bytes: new TextEncoder().encode(text),
        parseState: "parsed",
        stringRanges: ranges,
      }),
    ]).endpoints;

    expect(endpoint?.normalizedValue).toBe("evil.test");
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("still reports a URL with extra leading slashes", () => {
    expect(
      buildSignalSet([
        source("a.js", 'f("https:///evil.test/x");', "unparseable"),
      ]).endpoints.map(({ normalizedValue }) => normalizedValue),
    ).toEqual(["evil.test"]);
  });

  it("keeps a prose URL that runs into a template expression at unknown", () => {
    const text = "f(`docs https://evil.test/${x}`);";
    const [endpoint] = buildSignalSet([
      observeSignalSource({
        file: "a.js",
        bytes: new TextEncoder().encode(text),
        parseState: "parsed",
        stringRanges: [[3, text.indexOf("${"), true]],
      }),
    ]).endpoints;

    expect(endpoint).toMatchObject({
      normalizedValue: "evil.test",
      context: "unknown",
    });
  });

  it("trims many trailing brackets from a host in linear time", () => {
    const text = `f("https://evil.test${")".repeat(80_000)}z");`;

    const started = performance.now();
    buildSignalSet([source("a.js", text, "unparseable")]);

    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("does not report a URL found inside another URL's query", () => {
    expect(
      buildSignalSet([
        source("a.js", 'f("https://?x=https://evil.test");', "unparseable"),
      ]).endpoints,
    ).toEqual([]);
  });

  it("builds a snippet for a line of many carriage returns in linear time", () => {
    const text = `${"\r".repeat(200_000)}x https://evil.test`;

    const started = performance.now();
    buildSignalSet([source("a.js", text, "unparseable")]);

    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it.each(["https://evil.test\u0000/x", "https://evil.test\u0001?x"])(
    "rejects a host followed by a control character (%j)",
    (url) => {
      expect(
        buildSignalSet([source("a.js", `f("${url}");`, "unparseable")])
          .endpoints,
      ).toEqual([]);
    },
  );

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
