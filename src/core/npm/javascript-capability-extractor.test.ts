import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { diffManifestCapabilities } from "../capability-differ.js";
import {
  CAPABILITY_SET_SCHEMA_VERSION,
  type CapabilitySet,
} from "../contract/capability-set.js";
import { diffSignals } from "../signal-differ.js";
import { emptySignalSet } from "../signal-extractor.js";
import {
  JavaScriptCapabilityExtractorConfigurationError,
  JavaScriptCapabilityExtractorError,
  extractNpmJavaScriptCapabilities,
  mergeJavaScriptCapabilityLayer,
} from "./javascript-capability-extractor.js";
import { extractNpmManifestCapabilities } from "./manifest-capability-extractor.js";

const manifestSet: CapabilitySet = {
  schemaVersion: CAPABILITY_SET_SCHEMA_VERSION,
  subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
  completeness: "complete",
  capabilities: [],
  diagnostics: [],
};

describe("analysis cancellation", () => {
  it("stops before enumerating an aborted package", async () => {
    const controller = new AbortController();
    controller.abort();
    await withPackage({ "index.js": "fetch('inert')" }, async (root) => {
      await expect(
        extractNpmJavaScriptCapabilities({ root }, manifestSet, {
          signal: controller.signal,
        }),
      ).rejects.toThrow(JavaScriptCapabilityExtractorError);
    });
  });

  it("rejects a signal-like object without removeEventListener", async () => {
    await withPackage({ "index.js": "inert" }, async (root) => {
      await expect(
        extractNpmJavaScriptCapabilities({ root }, manifestSet, {
          signal: {
            aborted: false,
            addEventListener: () => undefined,
          } as unknown as AbortSignal,
        }),
      ).rejects.toThrow(JavaScriptCapabilityExtractorConfigurationError);
    });
  });
});

async function withPackage(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "capdelta-ast-test-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "2.0.0" }),
    );
    for (const [file, source] of Object.entries(files)) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), source);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("extractNpmJavaScriptCapabilities UNKNOWN", () => {
  it("reports a computed require honestly as UNKNOWN", async () => {
    await withPackage(
      { "index.js": "const cp = require('child' + '_process');\n" },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result).toEqual({
          capabilities: [
            {
              kind: "UNKNOWN",
              location: { kind: "runtime" },
              evidence: [
                {
                  file: "index.js",
                  line: 1,
                  snippet: "const cp = require('child' + '_process');",
                },
              ],
            },
          ],
          diagnostics: [],
          signals: {
            sourceFiles: [
              {
                file: "index.js",
                byteLength: 42,
                entropyMilliBitsPerByte: 4252,
                parseState: "parsed",
              },
            ],
            endpoints: [],
            obfuscationPatterns: [],
          },
        });
      },
    );
  });

  it("degrades loudly for TypeScript and malformed JavaScript", async () => {
    await withPackage(
      { "index.ts": "export const x = 1;", "bad.js": "const =" },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([]);
        expect(result.diagnostics.map((item) => item.kind)).toEqual([
          "unparseable-source",
          "unsupported-source",
        ]);
      },
    );
  });

  it("treats declaration files as non-executable metadata", async () => {
    await withPackage(
      {
        "types.d.ts": "declare const value: string;",
        "runtime.ts": "export const value = 1;",
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.diagnostics).toEqual([
          {
            kind: "unsupported-source",
            detail:
              "runtime.ts is TypeScript source; v0.1 parses JavaScript only",
            evidence: [{ file: "runtime.ts", line: 1, snippet: "" }],
          },
        ]);
        expect(result.signals?.sourceFiles.map((file) => file.file)).toEqual([
          "runtime.ts",
        ]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities PROCESS", () => {
  it("detects literal CommonJS and node:-prefixed ESM imports", async () => {
    await withPackage(
      {
        "common.cjs": "const cp = require('child_process');\n",
        "module.mjs": "import { spawn } from 'node:child_process';\n",
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "PROCESS",
            location: { kind: "runtime" },
            evidence: [
              {
                file: "common.cjs",
                line: 1,
                snippet: "const cp = require('child_process');",
              },
              {
                file: "module.mjs",
                line: 1,
                snippet: "import { spawn } from 'node:child_process';",
              },
            ],
          },
        ]);
      },
    );
  });

  it("does not pretend a computed module specifier is PROCESS", async () => {
    await withPackage(
      { "index.js": "require('child' + '_process').exec('echo test');\n" },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities.map((item) => item.kind)).toEqual([
          "UNKNOWN",
        ]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities NET", () => {
  it("detects network modules and unshadowed network globals", async () => {
    await withPackage(
      {
        "index.js": [
          "const https = require('node:https');",
          "fetch('https://example.test');",
          "new WebSocket('wss://example.test');",
        ].join("\n"),
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "NET",
            location: { kind: "runtime" },
            evidence: [
              {
                file: "index.js",
                line: 1,
                snippet: "const https = require('node:https');",
              },
              {
                file: "index.js",
                line: 2,
                snippet: "fetch('https://example.test');",
              },
              {
                file: "index.js",
                line: 3,
                snippet: "new WebSocket('wss://example.test');",
              },
            ],
          },
        ]);
      },
    );
  });

  it("does not confuse locally shadowed globals with network APIs", async () => {
    await withPackage(
      { "index.js": "function run(fetch) { fetch('local'); }\n" },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities FS_READ", () => {
  it("detects direct, destructured, and one-hop aliased fs reads", async () => {
    await withPackage(
      {
        "index.cjs": [
          "const fs = require('node:fs');",
          "fs.readFileSync('input.txt');",
          "const { readdir } = require('fs');",
          "readdir('.');",
          "const read = fs.readFile;",
          "read('input.txt', () => {});",
        ].join("\n"),
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "FS_READ",
            location: { kind: "runtime" },
            evidence: [
              {
                file: "index.cjs",
                line: 2,
                snippet: "fs.readFileSync('input.txt');",
              },
              { file: "index.cjs", line: 4, snippet: "readdir('.');" },
              {
                file: "index.cjs",
                line: 6,
                snippet: "read('input.txt', () => {});",
              },
            ],
          },
        ]);
      },
    );
  });

  it("reports a second alias hop as UNKNOWN instead of FS_READ", async () => {
    await withPackage(
      {
        "index.cjs":
          "const fs = require('fs');\nconst read = fs.readFile;\nconst again = read;\nagain('x');\n",
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities.map((item) => item.kind)).toEqual([
          "UNKNOWN",
        ]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities FS_WRITE", () => {
  it("detects filesystem mutations through namespace and named imports", async () => {
    await withPackage(
      {
        "index.mjs": [
          "import * as fs from 'node:fs';",
          "import { unlink as remove } from 'fs';",
          "fs.writeFileSync('output.txt', 'test');",
          "remove('old.txt', () => {});",
        ].join("\n"),
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "FS_WRITE",
            location: { kind: "runtime" },
            evidence: [
              {
                file: "index.mjs",
                line: 3,
                snippet: "fs.writeFileSync('output.txt', 'test');",
              },
              {
                file: "index.mjs",
                line: 4,
                snippet: "remove('old.txt', () => {});",
              },
            ],
          },
        ]);
      },
    );
  });
});

describe("single-walk binding index", () => {
  it("preserves forward aliases and nested shadowing", async () => {
    await withPackage(
      {
        "index.cjs": [
          "const read = fs.readFile;",
          "const fs = require('fs');",
          "read('input.txt', () => {});",
          "{ const process = { env: {} }; process.env.LOCAL; }",
          "function outer(fetch) { function inner() { fetch('local'); } inner(); }",
        ].join("\n"),
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );

        expect(result.capabilities.map(({ kind }) => kind)).toEqual([
          "FS_READ",
        ]);
        expect(result.diagnostics).toEqual([]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities FS_SENSITIVE", () => {
  it("adds sensitive-path context for credential reads and writes", async () => {
    await withPackage(
      {
        "index.cjs": [
          "const fs = require('fs');",
          "const path = require('path');",
          "const os = require('os');",
          "fs.readFileSync(path.join(os.homedir(), '.ssh', 'id_rsa'));",
          "fs.writeFileSync('.env.production', 'echo test');",
          "fs.readFileSync('.env.example');",
        ].join("\n"),
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        const byKind = new Map(
          result.capabilities.map((item) => [item.kind, item]),
        );
        expect(
          byKind.get("FS_SENSITIVE")?.evidence.map((item) => item.line),
        ).toEqual([4, 5]);
        expect(
          byKind.get("FS_READ")?.evidence.map((item) => item.line),
        ).toEqual([4, 6]);
        expect(
          byKind.get("FS_WRITE")?.evidence.map((item) => item.line),
        ).toEqual([5]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities ENV", () => {
  it("detects static and computed-literal process.env access", async () => {
    await withPackage(
      {
        "index.js":
          "const token = process.env.TOKEN;\nconst home = process['env'].HOME;\n",
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "ENV",
            location: { kind: "runtime" },
            evidence: [
              {
                file: "index.js",
                line: 1,
                snippet: "const token = process.env.TOKEN;",
              },
              {
                file: "index.js",
                line: 2,
                snippet: "const home = process['env'].HOME;",
              },
            ],
          },
        ]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities DYNAMIC_CODE", () => {
  it("detects eval, Function construction, and vm imports", async () => {
    await withPackage(
      {
        "index.cjs": [
          "const vm = require('node:vm');",
          "eval('1 + 1');",
          "new Function('return 1');",
        ].join("\n"),
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "DYNAMIC_CODE",
            location: { kind: "runtime" },
            evidence: [
              {
                file: "index.cjs",
                line: 1,
                snippet: "const vm = require('node:vm');",
              },
              { file: "index.cjs", line: 2, snippet: "eval('1 + 1');" },
              {
                file: "index.cjs",
                line: 3,
                snippet: "new Function('return 1');",
              },
            ],
          },
        ]);
      },
    );
  });
});

describe("extractNpmJavaScriptCapabilities NATIVE", () => {
  it("detects native artifacts and WebAssembly loading", async () => {
    await withPackage(
      {
        "build/Release/addon.node": "inert fixture",
        "binding.gyp": "{}",
        "index.js":
          "WebAssembly.instantiate(new Uint8Array());\nrequire('./build/Release/addon.node');\n",
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          manifestSet,
        );
        const native = result.capabilities.find(
          (item) => item.kind === "NATIVE",
        );
        expect(native?.evidence.map((item) => [item.file, item.line])).toEqual([
          ["binding.gyp", 1],
          ["build/Release/addon.node", 1],
          ["index.js", 1],
          ["index.js", 2],
        ]);
      },
    );
  });
});

describe("install-script location attribution", () => {
  it("attributes a literal node entrypoint to its invoking hook", async () => {
    const installSet: CapabilitySet = {
      ...manifestSet,
      capabilities: [
        {
          kind: "INSTALL_HOOK",
          location: {
            kind: "install-script",
            hook: "postinstall",
            applicability: "registry-install",
          },
          contentDigest: { algorithm: "sha256", value: "0".repeat(64) },
          evidence: [{ file: "package.json", line: 1, snippet: "postinstall" }],
        },
      ],
    };
    await withPackage(
      {
        "package.json": JSON.stringify({
          name: "fixture",
          version: "2.0.0",
          scripts: { postinstall: "node ./scripts/install.js" },
        }),
        "scripts/install.js": "fetch('https://example.test');\n",
      },
      async (root) => {
        const result = await extractNpmJavaScriptCapabilities(
          { root },
          installSet,
        );
        expect(result.capabilities).toEqual([
          {
            kind: "NET",
            location: {
              kind: "install-script",
              hook: "postinstall",
              applicability: "registry-install",
            },
            evidence: [
              {
                file: "scripts/install.js",
                line: 1,
                snippet: "fetch('https://example.test');",
              },
            ],
          },
        ]);
      },
    );
  });
});

describe("endpoint signals and parser comments", () => {
  async function endpointsOf(files: Record<string, string>): Promise<string[]> {
    let hosts: string[] = [];
    await withPackage(files, async (root) => {
      const result = await extractNpmJavaScriptCapabilities(
        { root },
        manifestSet,
      );
      hosts = (result.signals?.endpoints ?? []).map(
        (item) => item.normalizedValue,
      );
    });
    return hosts;
  }

  it("ignores real comments but keeps strings and templates that look like comments", async () => {
    const hosts = await endpointsOf({
      "index.js": [
        "// https://line-comment.example.org",
        "/* http://203.0.113.5 https://block-comment.example.org */",
        'const real = "https://api.example.net/x";',
        'const s = "/* https://string.example.com */ // https://string2.example.com";',
        "const t = `${/* https://template-comment.example.org */ 1} https://template.example.com`;",
        'const e = "\u{1F600}😀"; // https://after-emoji.example.org',
        'const after = "https://after-emoji-real.example.net";',
        "",
      ].join("\n"),
    });
    expect(hosts.sort()).toEqual(
      [
        "after-emoji-real.example.net",
        "api.example.net",
        "string.example.com",
        "string2.example.com",
        "template.example.com",
      ].sort(),
    );
  });

  it("uses only the successful script attempt's comments after a module parse fails", async () => {
    const hosts = await endpointsOf({
      "legacy.js":
        '// https://first.example.org\nwith (o) { x = "https://kept.example.org"; }\n',
    });
    expect(hosts).toEqual(["kept.example.org"]);
  });

  it.each([
    [
      "a URL that runs from a label into a line comment",
      "https://label.example.org\nvoid 0;\n",
      [],
    ],
    [
      "a hashbang line",
      "#!/usr/bin/env node https://hashbang.example.org\nconst x = 'https://kept.example.net';\n",
      ["kept.example.net"],
    ],
    [
      "a regex literal containing comment-like text",
      "const r = /[/*]/;\nfetch('https://after-regex.example.org');\n",
      ["after-regex.example.org"],
    ],
  ])("handles %s", async (_label, source, expected) => {
    expect(await endpointsOf({ "index.js": source })).toEqual(expected);
  });

  it("still byte-scans unsupported TypeScript, comments included", async () => {
    let result:
      Awaited<ReturnType<typeof extractNpmJavaScriptCapabilities>> | undefined;
    await withPackage(
      {
        "src/types.ts":
          "// https://ts-comment.example.org\nexport type T = 1;\n",
      },
      async (root) => {
        result = await extractNpmJavaScriptCapabilities({ root }, manifestSet);
      },
    );
    expect(
      result?.signals?.endpoints.map((item) => item.normalizedValue),
    ).toEqual(["ts-comment.example.org"]);
    expect(result?.diagnostics).toEqual([
      expect.objectContaining({ kind: "unsupported-source" }),
    ]);
  });

  it("keeps lexical candidates in comments when the file cannot be parsed", async () => {
    const hosts = await endpointsOf({
      "broken.js": "// https://unparsed.example.org\nconst = ;\n",
    });
    expect(hosts).toEqual(["unparsed.example.org"]);
  });

  it("creates no HIGH endpoint finding for a comment-only change, but does for real code", async () => {
    const analyze = async (files: Record<string, string>, version: string) => {
      let set:
        Awaited<ReturnType<typeof mergeJavaScriptCapabilityLayer>> | undefined;
      await withPackage(files, async (root) => {
        const manifest = await extractNpmManifestCapabilities(
          { root },
          { ecosystem: "npm", name: "fixture", version },
        );
        if (manifest.status !== "analyzed")
          throw new Error("manifest unavailable");
        set = mergeJavaScriptCapabilityLayer(
          manifest.set,
          await extractNpmJavaScriptCapabilities({ root }, manifest.set),
        );
      });
      if (set === undefined) throw new Error("analysis did not run");
      return set;
    };
    const base = await analyze(
      { "index.js": "module.exports = 1;\n" },
      "2.0.0",
    );
    const commentOnly = await analyze(
      {
        "index.js": "// docs: https://docs.example.org\nmodule.exports = 1;\n",
      },
      "2.0.0",
    );
    const realCode = await analyze(
      {
        "index.js":
          'module.exports = () => fetch("https://api.example.net");\n',
      },
      "2.0.0",
    );
    const highEndpoints = (next: typeof base) =>
      (diffManifestCapabilities(base, next).signalFindings ?? []).filter(
        (finding) => finding.kind === "new-external-endpoint",
      );
    expect(highEndpoints(commentOnly)).toEqual([]);
    expect(highEndpoints(realCode)).toEqual([
      expect.objectContaining({
        severity: "HIGH",
        detail: "new external domain api.example.net",
      }),
    ]);
  });
});

describe("endpoint context", () => {
  async function endpointsOf(
    files: Record<string, string>,
  ): Promise<{ host: string; context: string }[]> {
    let endpoints: { host: string; context: string }[] = [];
    await withPackage(files, async (root) => {
      const result = await extractNpmJavaScriptCapabilities(
        { root },
        manifestSet,
      );
      endpoints = (result.signals?.endpoints ?? []).map((item) => ({
        host: item.normalizedValue,
        context: item.context,
      }));
    });
    return endpoints;
  }

  it("classifies a URL that is the whole string literal as literal", async () => {
    expect(
      await endpointsOf({ "index.js": 'fetch("https://a.test/x");' }),
    ).toEqual([{ host: "a.test", context: "literal" }]);
  });

  it("trims surrounding whitespace before comparing string content", async () => {
    expect(
      await endpointsOf({ "index.js": 'const u = "  https://a.test/x  ";' }),
    ).toEqual([{ host: "a.test", context: "literal" }]);
  });

  it("classifies a shell comment inside a template as embedded-text", async () => {
    expect(
      await endpointsOf({
        "index.js": [
          "const script = `#!/bin/sh",
          "# see https://a.test/doc",
          "echo hi`;",
        ].join("\n"),
      }),
    ).toEqual([{ host: "a.test", context: "embedded-text" }]);
  });

  it("classifies a URL inside a sentence as embedded-text", async () => {
    expect(
      await endpointsOf({
        "index.js": 'const u = "see https://a.test/doc for details";',
      }),
    ).toEqual([{ host: "a.test", context: "embedded-text" }]);
  });

  it("keeps a whole-string URL literal when an escape sequence follows it", async () => {
    expect(
      await endpointsOf({ "index.js": 'fetch("https://a.test/x\\n");' }),
    ).toEqual([{ host: "a.test", context: "literal" }]);
  });

  it("keeps a URL literal when an escape sequence sits in its path", async () => {
    expect(
      await endpointsOf({ "index.js": 'fetch("https://a.test/\\x61b");' }),
    ).toEqual([{ host: "a.test", context: "literal" }]);
  });

  it("classifies a URL followed by a word in the same string as embedded-text", async () => {
    expect(
      await endpointsOf({ "index.js": 'fetch("https://a.test/c? x");' }),
    ).toEqual([{ host: "a.test", context: "embedded-text" }]);
  });

  it("does not classify a bare IP literal by its string", async () => {
    expect(
      await endpointsOf({ "index.js": 'const u = "connect to 8.8.4.4 now";' }),
    ).toEqual([{ host: "8.8.4.4", context: "unknown" }]);
  });

  it.each([
    [
      "a quoted string with a LF line continuation",
      '"https://a.test/\\\ncollect"',
    ],
    [
      "a quoted string with a CRLF line continuation",
      '"https://a.test/\\\r\ncollect"',
    ],
    ["a template with a LF line continuation", "`https://a.test/\\\ncollect`"],
    [
      "a template with a CRLF line continuation",
      "`https://a.test/\\\r\ncollect`",
    ],
    [
      "a template with a newline the URL parser drops",
      "`https://a.test/\ncollect`",
    ],
  ])("keeps a URL literal in %s", async (_label, literal) => {
    expect(await endpointsOf({ "index.js": `fetch(${literal});` })).toEqual([
      { host: "a.test", context: "literal" },
    ]);
  });

  it.each([
    ["an escaped newline before a space", 'fetch("\\n https://evil.test/x");'],
    ["an escaped newline after a space", 'fetch("https://evil.test/x \\n");'],
    ["an escaped leading space", 'fetch("\\ https://evil.test/x");'],
    ["a hex escape for a leading space", 'fetch("\\x20 https://evil.test/x");'],
    [
      "a Unicode escape for a trailing space",
      'fetch("https://evil.test/x\\u{20}");',
    ],
    ["tab escapes around the URL", 'fetch("\\t https://evil.test/x\\t");'],
    [
      "a Unicode escape for an internal space",
      'fetch("https://evil.test/x\\u0020y");',
    ],
    [
      "an escaped newline before a space in a template",
      "fetch(`\\n https://evil.test/x`);",
    ],
    [
      "an invalid escape in a tagged template",
      "fetch(String.raw`\\u https://evil.test/x`);",
    ],
  ])(
    "classifies a string whose value is the URL as literal for %s",
    async (_label, source) => {
      expect(await endpointsOf({ "index.js": source })).toEqual([
        { host: "evil.test", context: "literal" },
      ]);
    },
  );

  it.each([
    ["a query with a space", 'fetch("https://evil.test/c? x");'],
    [
      "a newline-separated sentence",
      'fetch("line one\\nsee https://a.test/doc");',
    ],
  ])("keeps embedded-text for %s", async (_label, source) => {
    expect(await endpointsOf({ "index.js": source })).toEqual([
      {
        host: source.includes("evil.test") ? "evil.test" : "a.test",
        context: "embedded-text",
      },
    ]);
  });

  it("classifies a template that ends at an expression as literal", async () => {
    expect(
      await endpointsOf({
        "index.js":
          'const path = "segment";\nconst u = `https://a.test/${path}`;',
      }),
    ).toEqual([{ host: "a.test", context: "literal" }]);
  });

  it("classifies a URL in a file the parser rejects as unknown", async () => {
    expect(
      await endpointsOf({
        "index.js": "// https://a.test/doc\nconst = ;\n",
      }),
    ).toEqual([{ host: "a.test", context: "unknown" }]);
  });

  it("keeps the strongest context when the same host appears in two files", async () => {
    expect(
      await endpointsOf({
        "index.js": 'const u = "see https://a.test/doc";',
        "other.js": 'fetch("https://a.test/x");',
      }),
    ).toEqual([{ host: "a.test", context: "literal" }]);
  });

  it("keeps embedded-text when every occurrence is embedded-text", async () => {
    expect(
      await endpointsOf({
        "index.js": [
          'const a = "see https://a.test/doc";',
          'const b = "docs https://a.test/doc";',
        ].join("\n"),
      }),
    ).toEqual([{ host: "a.test", context: "embedded-text" }]);
  });

  it("still excludes a URL written in a JavaScript comment", async () => {
    expect(
      await endpointsOf({
        "index.js": [
          "// https://comments.test/doc",
          "module.exports = 1;",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it.each([
    [
      "the same host on both sides",
      "const tag = (p) => fetch(p[1]);\ntag`See https://evil.test/${0}https://evil.test/`;",
      [{ host: "evil.test", context: "literal" }],
    ],
    [
      "different hosts on each side",
      "const tag = (p) => fetch(p[1]);\ntag`See https://a.test/${0}https://evil.test/`;",
      [
        { host: "a.test", context: "unknown" },
        { host: "evil.test", context: "literal" },
      ],
    ],
    [
      "a URL whose userinfo ends in the next element",
      "fetch(`https://a.test${0}@evil.test/`);",
      [
        { host: "a.test", context: "literal" },
        { host: "evil.test", context: "unknown" },
      ],
    ],
  ])(
    "scans each template element on its own for %s",
    async (_label, text, expected) => {
      expect(await endpointsOf({ "index.js": text })).toEqual(expected);
    },
  );
});

describe("bare IPv6 context (ADR-027)", () => {
  async function findingsOf(files: Record<string, string>) {
    let findings: ReturnType<typeof diffSignals> = [];
    await withPackage(files, async (root) => {
      const result = await extractNpmJavaScriptCapabilities(
        { root },
        manifestSet,
      );
      findings = diffSignals(null, result.signals ?? emptySignalSet()).filter(
        (finding) => finding.kind === "new-external-endpoint",
      );
    });
    return findings;
  }

  it("reports a new host glued inside text at LOW", async () => {
    const findings = await findingsOf({
      "index.js": 'const data = "prefix =C::9bb~ suffix";',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "LOW",
        detail: "new external ipv6 c::9bb (inside a longer string)",
      }),
    ]);
  });

  it.each([
    ["a whole-string literal", 'const a = "2001:db8::1";'],
    ["a bracketed host and port", 'const a = "[2001:db8::1]:443";'],
    ["a comma-separated list", 'const a = "2001:db8::1,2001:db8::2";'],
    [
      "a zone ID",
      'net.connect({ host: "2001:4860:4860::8888%eth0", port: 443 });',
    ],
    ["a key-value string", 'const a = "host=2001:4860:4860::8888&port=443";'],
    ["a dotted IPv4 tail", 'const host = "2001:4860:4860::127.0.0.1";'],
    ["a sentence", 'const a = "connect to 2001:db8::1 now";'],
  ])("keeps %s at HIGH", async (_label, source) => {
    const findings = await findingsOf({ "index.js": source });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.severity === "HIGH")).toBe(true);
    expect(
      findings.some((finding) => finding.detail.includes("inside a longer")),
    ).toBe(false);
  });

  it("keeps a glued match in a string that holds a backslash at HIGH", async () => {
    const findings = await findingsOf({
      "index.js": 'const data = "prefix =C::9bb~ suffix\\n";',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external ipv6 c::9bb",
      }),
    ]);
  });

  it("keeps a glued match in a file that does not parse at HIGH", async () => {
    const findings = await findingsOf({
      "index.js": 'const data = "prefix =C::9bb~ suffix";\nconst = ;\n',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
      }),
    ]);
  });

  it("keeps a host glued in one file and whole in another at HIGH", async () => {
    const findings = await findingsOf({
      "index.js": 'const a = "x2001:db8::1y";',
      "other.js": 'const b = "2001:db8::1";',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external ipv6 2001:db8::1",
      }),
    ]);
  });

  it("keeps a glued IPv4 match at HIGH", async () => {
    const findings = await findingsOf({
      "index.js": 'const data = "prefix =1.2.3.4~ suffix";',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external ipv4 1.2.3.4",
      }),
    ]);
  });
});

// ADR-024 Consequences: these two cases document the destination-swap boundary
// for a package that already has a network call. The endpoint finding is a hint
// for reviewers, not a gate guarantee; capabilities and shapes carry the gate.
describe("destination swap inside text (ADR-024 boundary)", () => {
  async function analyze(
    files: Record<string, string>,
    version: string,
  ): Promise<CapabilitySet> {
    let result: CapabilitySet | undefined;
    await withPackage(files, async (root) => {
      const manifest = await extractNpmManifestCapabilities(
        { root },
        { ecosystem: "npm", name: "fixture", version },
      );
      if (manifest.status !== "analyzed")
        throw new Error("manifest unavailable");
      result = mergeJavaScriptCapabilityLayer(
        manifest.set,
        await extractNpmJavaScriptCapabilities({ root }, manifest.set),
      );
    });
    if (result === undefined) throw new Error("analysis did not run");
    return result;
  }

  it("keeps an existing network call and reports the prose host at LOW only", async () => {
    const base = await analyze(
      { "index.js": 'fetch("https://api.good.test/x");\n' },
      "2.0.0",
    );
    const head = await analyze(
      { "index.js": 'fetch("see https://evil.test/c now".split(" ")[1]);\n' },
      "2.0.0",
    );
    const diff = diffManifestCapabilities(base, head);

    expect(diff.findings).toEqual([]);
    expect(diff.shapes).toEqual([]);
    expect(diff.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "LOW",
        detail: "new external domain evil.test (mentioned in text)",
      }),
    ]);
  });

  it("reports no endpoint when the new version assembles the URL from pieces", async () => {
    const base = await analyze(
      { "index.js": 'fetch("https://api.good.test/x");\n' },
      "2.0.0",
    );
    const head = await analyze(
      { "index.js": 'fetch("ht" + "tps://evil.test/c");\n' },
      "2.0.0",
    );
    const diff = diffManifestCapabilities(base, head);

    expect(diff.findings).toEqual([]);
    expect(diff.signalFindings).toEqual([]);
  });
});

describe("template element boundary (ADR-024)", () => {
  async function analyze(
    files: Record<string, string>,
    version: string,
  ): Promise<CapabilitySet> {
    let result: CapabilitySet | undefined;
    await withPackage(files, async (root) => {
      const manifest = await extractNpmManifestCapabilities(
        { root },
        { ecosystem: "npm", name: "fixture", version },
      );
      if (manifest.status !== "analyzed")
        throw new Error("manifest unavailable");
      result = mergeJavaScriptCapabilityLayer(
        manifest.set,
        await extractNpmJavaScriptCapabilities({ root }, manifest.set),
      );
    });
    if (result === undefined) throw new Error("analysis did not run");
    return result;
  }

  it("reports the fetched element at HIGH when prose mentions the same host", async () => {
    const base = await analyze(
      { "index.js": "module.exports = 1;\n" },
      "2.0.0",
    );
    const head = await analyze(
      {
        "index.js":
          "const tag = (p) => fetch(p[1]);\ntag`See https://evil.test/${0}https://evil.test/`;",
      },
      "2.0.0",
    );
    const diff = diffManifestCapabilities(base, head);

    expect(diff.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain evil.test",
      }),
    ]);
  });

  it("reports both hosts at HIGH when the prose URL runs into an expression", async () => {
    const base = await analyze(
      { "index.js": "module.exports = 1;\n" },
      "2.0.0",
    );
    const head = await analyze(
      {
        "index.js":
          "const tag = (p) => fetch(p[1]);\ntag`See https://a.test/${0}https://evil.test/`;",
      },
      "2.0.0",
    );
    const diff = diffManifestCapabilities(base, head);

    expect(diff.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain a.test",
      }),
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain evil.test",
      }),
    ]);
  });
});

// The copied files keep sourceMappingURL comments after the maps are dropped.
// Leaving them in makes Vite log a stack trace for every imported module.
async function stripSourceMapComments(directory: string): Promise<void> {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith(".js")) continue;
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace(/^\/\/# sourceMappingURL=.*$/gmu, ""));
  }
}

// The built tree is copied so the test can break only the copy's worker. The
// copy is a different module instance, so compare errors by name, not class.
describe("extractNpmJavaScriptCapabilities worker start (ADR-025)", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..");

  async function withCopiedExtractor(
    prepareWorker: (workerPath: string) => Promise<void>,
    run: (extract: (root: string) => Promise<unknown>) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "capdelta-worker-test-"));
    try {
      await cp(join(repoRoot, "dist", "core"), join(root, "dist", "core"), {
        recursive: true,
        filter: (source) => !source.endsWith(".map"),
      });
      await stripSourceMapComments(join(root, "dist", "core"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      await prepareWorker(
        join(root, "dist", "core", "npm", "javascript-parser-worker.js"),
      );
      const module = (await import(
        pathToFileURL(
          join(
            root,
            "dist",
            "core",
            "npm",
            "javascript-capability-extractor.js",
          ),
        ).href
      )) as {
        extractNpmJavaScriptCapabilities: typeof extractNpmJavaScriptCapabilities;
      };
      await run((packageRoot) =>
        module.extractNpmJavaScriptCapabilities(
          { root: packageRoot },
          manifestSet,
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it.each([
    [
      "is missing",
      async (workerPath: string): Promise<void> => {
        await rm(workerPath);
      },
    ],
    [
      "throws while loading",
      async (workerPath: string): Promise<void> => {
        await writeFile(workerPath, 'throw new Error("broken");\n');
      },
    ],
  ])("fails the run when the worker %s", async (_label, prepareWorker) => {
    await withCopiedExtractor(prepareWorker, async (extract) => {
      await withPackage(
        { "index.js": "module.exports = 1;\n" },
        async (root) => {
          const error: unknown = await extract(root).then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).name).toBe(
            "JavaScriptCapabilityExtractorConfigurationError",
          );
          expect((error as Error).message).toMatch(
            /^JavaScript parser worker failed to start/u,
          );
          expect((error as Error).cause).toBeInstanceOf(Error);
        },
      );
    });
  });

  it("keeps a worker crash while parsing as an unparseable-source diagnostic", async () => {
    await withCopiedExtractor(
      async (workerPath) => {
        await writeFile(
          workerPath,
          [
            'import { parentPort } from "node:worker_threads";',
            'parentPort.on("message", () => {',
            '  throw new Error("crash after ready");',
            "});",
            'parentPort.postMessage({ type: "ready" });',
            "",
          ].join("\n"),
        );
      },
      async (extract) => {
        await withPackage(
          { "index.js": "module.exports = 1;\n" },
          async (root) => {
            const result = (await extract(root)) as Awaited<
              ReturnType<typeof extractNpmJavaScriptCapabilities>
            >;
            expect(result.diagnostics).toEqual([
              {
                kind: "unparseable-source",
                detail: "JavaScript parser worker failed: Error",
                evidence: [{ file: "index.js", line: 1, snippet: "" }],
              },
            ]);
          },
        );
      },
    );
  });
});
