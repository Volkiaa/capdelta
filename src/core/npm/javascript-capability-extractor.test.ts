import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SET_SCHEMA_VERSION,
  type CapabilitySet,
} from "../contract/capability-set.js";
import { extractNpmJavaScriptCapabilities } from "./javascript-capability-extractor.js";

const manifestSet: CapabilitySet = {
  schemaVersion: CAPABILITY_SET_SCHEMA_VERSION,
  subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
  completeness: "complete",
  capabilities: [],
  diagnostics: [],
};

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
