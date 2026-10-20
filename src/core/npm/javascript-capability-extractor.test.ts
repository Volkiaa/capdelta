import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffManifestCapabilities } from "../capability-differ.js";
import {
  CAPABILITY_SET_SCHEMA_VERSION,
  type CapabilitySet,
} from "../contract/capability-set.js";
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
});
