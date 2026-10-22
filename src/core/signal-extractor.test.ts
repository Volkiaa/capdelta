import { describe, expect, it } from "vitest";
import {
  MIN_OBFUSCATION_ARRAY_ELEMENTS,
  type SignalSourceInput,
  buildSignalSet,
  observeSignalSource,
} from "./signal-extractor.js";
import { diffSignals } from "./signal-differ.js";

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

  describe("scheme forms the URL parser accepts", () => {
    // WHATWG reads these special schemes case-insensitively and accepts any
    // run of "/" or "\" after the ":" as the authority separator.
    const forms = [
      ["an upper-case scheme", "HTTPS://exfil.example.test/x", null],
      ["a mixed-case scheme", "hTtP://exfil.example.test", null],
      ["no slash after the colon", "https:exfil.example.test/x", null],
      ["one slash after the colon", "https:/exfil.example.test/x", null],
      [
        "two escaped backslashes in source",
        String.raw`https:\\exfil.example.test/x`,
        String.raw`https:\exfil.example.test/x`,
      ],
      [
        "four escaped backslashes in source",
        String.raw`https:\\\\exfil.example.test`,
        String.raw`https:\\exfil.example.test`,
      ],
      [
        "a slash and a backslash",
        String.raw`https:/\exfil.example.test`,
        "https:/exfil.example.test",
      ],
    ] as const;

    const quoted = (content: string): string => `fetch("${content}");`;
    const parsedEndpoints = (content: string, cooked: string | null) => {
      const text = quoted(content);
      const start = text.indexOf('"') + 1;
      return buildSignalSet([
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          stringRanges: [[start, text.lastIndexOf('"'), false]],
          ...(cooked === null ? {} : { cookedStrings: [[start, cooked]] }),
        }),
      ]).endpoints;
    };

    it.each(forms)(
      "reports a literal domain for %s",
      (_label, form, cooked) => {
        expect(parsedEndpoints(form, cooked)).toEqual([
          expect.objectContaining({
            endpointType: "domain",
            normalizedValue: "exfil.example.test",
            confidence: "literal",
            context: "literal",
            provenance: "additive",
          }),
        ]);
      },
    );

    it.each(forms)("reports a byte-scan domain for %s", (_label, form) => {
      expect(
        buildSignalSet([source("index.js", quoted(form), "unparseable")])
          .endpoints,
      ).toEqual([
        expect.objectContaining({
          endpointType: "domain",
          normalizedValue: "exfil.example.test",
          confidence: "byte-scan-candidate",
          provenance: "additive",
        }),
      ]);
    });

    it.each([
      ["a scheme alone", '"https:"'],
      ["a scheme in prose", '"protocol https:"'],
      ["a single-label host", '"https:foo"'],
    ])("reports no endpoint for %s", (_label, literal) => {
      expect(
        buildSignalSet([source("index.js", `fetch(${literal});`)]).endpoints,
      ).toEqual([]);
    });

    it.each(forms)("still excludes %s in a comment", (_label, form) => {
      const comment = `// ${form}`;
      const text = `${comment}\nfetch("https://api.example.test/x");`;
      const endpoints = buildSignalSet([
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          commentRanges: [[0, comment.length]],
          stringRanges: [[text.indexOf('"') + 1, text.lastIndexOf('"'), false]],
        }),
      ]).endpoints;
      expect(endpoints.map((item) => item.normalizedValue)).toEqual([
        "api.example.test",
      ]);
    });

    it.each([
      [
        String.raw`https://\\evil.example.test/x`,
        String.raw`https://\evil.example.test/x`,
      ],
      [
        String.raw`https://\\\\evil.example.test/x`,
        String.raw`https://\\evil.example.test/x`,
      ],
    ])("extends main's prefix through separators in %s", (raw, cooked) => {
      for (const endpoints of [
        parsedEndpoints(raw, null),
        parsedEndpoints(raw, cooked),
        buildSignalSet([source("index.js", quoted(raw), "unparseable")])
          .endpoints,
      ]) {
        expect(endpoints.map((item) => item.normalizedValue)).toContain(
          "evil.example.test",
        );
      }
    });

    it.each(["/", "?next=", String.raw`\\`, String.raw`?next=\\`])(
      "keeps nested schemes in a URL's %s span",
      (delimiter) => {
        const base = `https://cdn.example.test${delimiter}HTTPS://evil.example.test`;
        const head = "https://evil.example.test";
        const scans = [
          (value: string) => parsedEndpoints(value, null),
          (value: string) =>
            parsedEndpoints(value, value.replaceAll(String.raw`\\`, "\\")),
          (value: string) =>
            buildSignalSet([source("index.js", quoted(value), "unparseable")])
              .endpoints,
        ];
        for (const scan of scans) {
          const oldHosts = new Set(
            scan(base).map((item) => item.normalizedValue),
          );
          expect([...oldHosts]).toEqual(["cdn.example.test"]);
          const added = scan(head).filter(
            (item) => !oldHosts.has(item.normalizedValue),
          );
          expect(added.map((item) => item.normalizedValue)).toEqual([
            "evil.example.test",
          ]);
        }
      },
    );

    it("keeps main's host when a raw escaped scheme hides the next URL", () => {
      const content = String.raw`https:\\https://evil.test/x`;
      const text = `fetch("${content}");`;
      const start = text.indexOf('"') + 1;
      const parsed = buildSignalSet([
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          stringRanges: [[start, text.lastIndexOf('"'), false]],
          cookedStrings: [[start, String.raw`https:\https://evil.test/x`]],
        }),
      ]).endpoints;
      expect(parsed.map((item) => item.normalizedValue)).toContain("evil.test");
      expect(
        buildSignalSet([source("index.js", text, "unparseable")]).endpoints.map(
          (item) => item.normalizedValue,
        ),
      ).toContain("evil.test");
    });

    it("keeps main's host in the element after an escaped scheme form", () => {
      const first = String.raw`https:\\`;
      const second = "https://evil.test/x";
      const text = "f(`" + first + "${x}" + second + "`);";
      const firstStart = text.indexOf("`") + 1;
      const secondStart = firstStart + first.length + "${x}".length;
      const endpoints = buildSignalSet([
        observeSignalSource({
          file: "index.js",
          bytes: new TextEncoder().encode(text),
          parseState: "parsed",
          stringRanges: [
            [firstStart, firstStart + first.length, false],
            [secondStart, text.lastIndexOf("`"), false],
          ],
          cookedStrings: [[firstStart, "https:\\"]],
        }),
      ]).endpoints;
      expect(endpoints.map((item) => item.normalizedValue)).toContain(
        "evil.test",
      );
    });

    it("scans 8,000 slashless template elements in linear time", () => {
      const element = "https:a${x}";
      const contentLength = "https:a".length;
      // CPU time, not wall time: other test files run in parallel, so wall time
      // measures scheduler contention as well as the scan.
      const measure = (count: number): { cpu: number; hosts: string[] } => {
        const text = `f(\`${element.repeat(count)}\`);`;
        const first = "f(`".length;
        const ranges: [number, number, boolean][] = [];
        for (let index = 0; index < count; index += 1) {
          const start = first + index * element.length;
          ranges.push([start, start + contentLength, false]);
        }
        const before = process.cpuUsage();
        const hosts = buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(text),
            parseState: "parsed",
            stringRanges: ranges,
          }),
        ]).endpoints.map((item) => item.normalizedValue);
        const used = process.cpuUsage(before);
        return { cpu: (used.user + used.system) / 1_000, hosts };
      };

      const best = (count: number) => {
        let result = measure(count);
        for (let attempt = 1; attempt < 3; attempt += 1) {
          const next = measure(count);
          if (next.cpu < result.cpu) result = next;
        }
        return result;
      };

      measure(1_000);
      const small = best(4_000);
      const large = best(8_000);
      expect(large.hosts).toEqual([]);
      expect(large.cpu).toBeLessThan(100);
      expect(large.cpu).toBeLessThan(small.cpu * 3 + 10);
    });

    describe("ADR-037 review pairs", () => {
      // The old side is the review's baseline, the new side the head that calls
      // the host directly. Main reaches the host on the new side, so an old
      // observation the widened rule alone produced must not hide it.
      const parsedSet = (
        text: string,
        ranges: [number, number, boolean][],
        cooked: [number, string][] = [],
      ) =>
        buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(text),
            parseState: "parsed",
            stringRanges: ranges,
            ...(cooked.length === 0 ? {} : { cookedStrings: cooked }),
          }),
        ]);

      const decodeEscape = (next: string): string => {
        if (next === "n") return "\n";
        if (next === "t") return "\t";
        if (next === "r") return "\r";
        return next;
      };

      const quotedSet = (text: string) => {
        const start = text.indexOf('"') + 1;
        const end = text.lastIndexOf('"');
        const body = text.slice(start, end);
        const cooked = body.includes("\\")
          ? body.replace(/\\(.)/gu, (_match, next: string) =>
              decodeEscape(next),
            )
          : null;
        return parsedSet(
          text,
          [[start, end, false]],
          cooked === null ? [] : [[start, cooked]],
        );
      };

      const newHosts = (oldText: string, newText: string): string[] =>
        diffSignals(quotedSet(oldText), quotedSet(newText))
          .filter((finding) => finding.kind === "new-external-endpoint")
          .map((finding) => finding.detail);

      it("reports the host reached after escaped separators (cr/f1-r2.md:419)", () => {
        const oldText = String.raw`fetch("https://\\evil.test/x");`;
        const oldEndpoints = quotedSet(oldText).endpoints;

        expect(oldEndpoints).toEqual([
          expect.objectContaining({
            normalizedValue: "evil.test",
            provenance: "additive",
          }),
        ]);
        expect(newHosts(oldText, 'fetch("https://evil.test");')).toEqual([
          "new external domain evil.test",
        ]);
      });

      it("reports the host when the old path holds a nested scheme (cr/f1-r2.md:414)", () => {
        expect(
          newHosts(
            'fetch("https://cdn.test/HTTPS://evil.test");',
            'fetch("https://evil.test");',
          ),
        ).toEqual(["new external domain evil.test"]);
      });

      it("reports the host after a backslash in the old path (cr/f1c.md:462)", () => {
        expect(
          newHosts(
            String.raw`fetch("https://cdn.example.test\\HTTPS://evil.example.test");`,
            'fetch("https://evil.example.test");',
          ),
        ).toEqual(["new external domain evil.example.test"]);
      });

      it("reports the host after a quote in the old path (cr/f1d.md:463)", () => {
        const oldText = String.raw`fetch("https://cdn.example.test/'HTTPS://exfil.example.test");`;

        expect(
          quotedSet(oldText).endpoints.map((endpoint) => [
            endpoint.normalizedValue,
            endpoint.provenance,
          ]),
        ).toEqual([
          ["cdn.example.test", "established"],
          ["exfil.example.test", "additive"],
        ]);
        expect(
          newHosts(oldText, 'fetch("https://exfil.example.test");'),
        ).toEqual(["new external domain exfil.example.test"]);
      });

      it("reports the host after an old template expression (cr/f1d.md:342)", () => {
        const oldText =
          'fetch(`https://cdn.example.test/${""}HTTPS://exfil.example.test`);';
        const firstStart = oldText.indexOf("`") + 1;
        const firstEnd = oldText.indexOf("${");
        const secondStart = oldText.indexOf("}", firstEnd) + 1;
        const secondEnd = oldText.lastIndexOf("`");
        const oldSet = parsedSet(oldText, [
          [firstStart, firstEnd, false],
          [secondStart, secondEnd, false],
        ]);

        expect(
          oldSet.endpoints.map((endpoint) => [
            endpoint.normalizedValue,
            endpoint.provenance,
          ]),
        ).toEqual([
          ["cdn.example.test", "established"],
          ["exfil.example.test", "additive"],
        ]);
        expect(
          diffSignals(oldSet, quotedSet('fetch("https://exfil.example.test");'))
            .filter((finding) => finding.kind === "new-external-endpoint")
            .map((finding) => finding.detail),
        ).toEqual(["new external domain exfil.example.test"]);
      });
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
