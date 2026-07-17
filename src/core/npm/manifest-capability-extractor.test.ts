import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PackageSubject } from "../contract/capability-set.js";
import {
  ManifestCapabilityExtractorConfigurationError,
  ManifestCapabilityExtractorContractError,
  extractNpmManifestCapabilities,
} from "./manifest-capability-extractor.js";

const SUBJECT: PackageSubject = {
  ecosystem: "npm",
  name: "@scope/fixture",
  version: "2.0.0",
};

async function withManifest<T>(
  manifest: string | Uint8Array | null,
  run: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "capdelta-manifest-test-"));
  try {
    if (manifest !== null)
      await writeFile(join(root, "package.json"), manifest);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("extractNpmManifestCapabilities", () => {
  it("extracts a complete, deterministic manifest capability set with exact evidence", async () => {
    const manifest = [
      "{",
      '  "name": "@scope/fixture",',
      '  "version": "2.0.0",',
      '  "scripts": {',
      '    "postinstall": "echo test",',
      '    "prepare": "echo prepare"',
      "  },",
      '  "bin": "bin/cli.js",',
      '  "dependencies": {',
      '    "left-pad": "^1.0.0"',
      "  },",
      '  "engines": {',
      '    "node": ">=20"',
      "  }",
      "}",
    ].join("\n");

    const result = await withManifest(manifest, (root) =>
      extractNpmManifestCapabilities({ root }, SUBJECT),
    );

    expect(result).toEqual({
      status: "analyzed",
      set: {
        schemaVersion: 1,
        subject: SUBJECT,
        completeness: "complete",
        capabilities: [
          {
            kind: "COMMAND_ENTRYPOINT",
            location: { kind: "runtime" },
            command: "fixture",
            target: "bin/cli.js",
            evidence: [
              {
                file: "package.json",
                line: 8,
                snippet: '"bin": "bin/cli.js",',
              },
            ],
          },
          {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: "left-pad",
            requirement: "^1.0.0",
            evidence: [
              {
                file: "package.json",
                line: 10,
                snippet: '"left-pad": "^1.0.0"',
              },
            ],
          },
          {
            kind: "INSTALL_HOOK",
            location: {
              kind: "install-script",
              hook: "postinstall",
              applicability: "registry-install",
            },
            contentDigest: {
              algorithm: "sha256",
              value: digest("echo test"),
            },
            evidence: [
              {
                file: "package.json",
                line: 5,
                snippet: '"postinstall": "echo test",',
              },
            ],
          },
          {
            kind: "INSTALL_HOOK",
            location: {
              kind: "install-script",
              hook: "prepare",
              applicability: "git-only",
            },
            contentDigest: {
              algorithm: "sha256",
              value: digest("echo prepare"),
            },
            evidence: [
              {
                file: "package.json",
                line: 6,
                snippet: '"prepare": "echo prepare"',
              },
            ],
          },
          {
            kind: "RUNTIME_CONSTRAINT",
            location: { kind: "manifest" },
            runtime: "node",
            requirement: ">=20",
            evidence: [
              {
                file: "package.json",
                line: 13,
                snippet: '"node": ">=20"',
              },
            ],
          },
        ],
        diagnostics: [],
      },
    });
  });

  it("returns a partial set and flags every malformed relevant field", async () => {
    const manifest = JSON.stringify(
      {
        name: SUBJECT.name,
        version: SUBJECT.version,
        scripts: { install: 42, postinstall: "echo test" },
        bin: { fixture: "bin.js", broken: false },
        dependencies: [],
        engines: { node: 20 },
      },
      null,
      2,
    );

    const result = await withManifest(manifest, (root) =>
      extractNpmManifestCapabilities({ root }, SUBJECT),
    );

    expect(result.status).toBe("analyzed");
    if (result.status !== "analyzed") throw new Error("expected analysis");
    expect(result.set.completeness).toBe("partial");
    expect(
      result.set.capabilities.map((capability) => capability.kind),
    ).toEqual(["COMMAND_ENTRYPOINT", "INSTALL_HOOK"]);
    expect(
      result.set.diagnostics.map((diagnostic) => diagnostic.detail),
    ).toEqual([
      "scripts.install must be a string",
      "bin.broken must be a string",
      "dependencies must be an object",
      "engines.node must be a string",
    ]);
    expect(
      result.set.diagnostics.every((item) => item.evidence.length > 0),
    ).toBe(true);
  });

  it.each([
    ["comments", '{"name":"@scope/fixture",/* no */"version":"2.0.0"}'],
    ["trailing commas", '{"name":"@scope/fixture","version":"2.0.0",}'],
    ["non-object root", "[]"],
    [
      "duplicate keys",
      '{"name":"@scope/fixture","version":"2.0.0","scripts":{"install":"echo test","install":"echo other"}}',
    ],
  ])(
    "rejects %s instead of accepting ambiguous JSON",
    async (_label, manifest) => {
      const result = await withManifest(manifest, (root) =>
        extractNpmManifestCapabilities({ root }, SUBJECT),
      );
      expect(result.status).toBe("unavailable");
      if (result.status !== "unavailable") throw new Error("expected failure");
      expect(["manifest-invalid-json", "manifest-invalid-root"]).toContain(
        result.failure.kind,
      );
      expect(result.failure.evidence).not.toBeNull();
    },
  );

  it("rejects invalid UTF-8, missing, and oversized manifests loudly", async () => {
    const invalidUtf8 = await withManifest(new Uint8Array([0xff]), (root) =>
      extractNpmManifestCapabilities({ root }, SUBJECT),
    );
    expect(invalidUtf8).toMatchObject({
      status: "unavailable",
      failure: { kind: "manifest-invalid-json" },
    });

    const missing = await withManifest(null, (root) =>
      extractNpmManifestCapabilities({ root }, SUBJECT),
    );
    expect(missing).toMatchObject({
      status: "unavailable",
      failure: { kind: "manifest-missing", evidence: null },
    });

    const oversized = await withManifest("{}", (root) =>
      extractNpmManifestCapabilities({ root }, SUBJECT, {
        maxManifestBytes: 1,
      }),
    );
    expect(oversized).toMatchObject({
      status: "unavailable",
      failure: { kind: "manifest-too-large" },
    });

    const notAFile = await withManifest(null, async (root) => {
      await mkdir(join(root, "package.json"));
      return extractNpmManifestCapabilities({ root }, SUBJECT);
    });
    expect(notAFile).toMatchObject({
      status: "unavailable",
      failure: { kind: "manifest-unreadable" },
    });
  });

  it("bounds evidence snippets while retaining the relevant source", async () => {
    const manifest = JSON.stringify({
      name: SUBJECT.name,
      version: SUBJECT.version,
      scripts: { postinstall: "echo test" },
      padding: "x".repeat(500),
    });
    const result = await withManifest(manifest, (root) =>
      extractNpmManifestCapabilities({ root }, SUBJECT),
    );

    expect(result.status).toBe("analyzed");
    if (result.status !== "analyzed") throw new Error("expected analysis");
    const hook = result.set.capabilities.find(
      (capability) => capability.kind === "INSTALL_HOOK",
    );
    expect(hook?.evidence[0].snippet).toContain("postinstall");
    expect(hook?.evidence[0].snippet.length).toBeLessThanOrEqual(240);
  });

  it("rejects a manifest whose identity differs from the lockfile subject", async () => {
    const result = await withManifest(
      '{"name":"other","version":"2.0.0"}',
      (root) => extractNpmManifestCapabilities({ root }, SUBJECT),
    );
    expect(result).toMatchObject({
      status: "unavailable",
      failure: { kind: "identity-mismatch" },
    });
  });

  it("throws typed errors for caller configuration and handoff contract bugs", async () => {
    await expect(
      extractNpmManifestCapabilities({ root: "relative" }, SUBJECT),
    ).rejects.toBeInstanceOf(ManifestCapabilityExtractorContractError);

    await withManifest("{}", async (root) => {
      await expect(
        extractNpmManifestCapabilities({ root }, SUBJECT, {
          maxManifestBytes: 0,
        }),
      ).rejects.toBeInstanceOf(ManifestCapabilityExtractorConfigurationError);
    });
  });
});
