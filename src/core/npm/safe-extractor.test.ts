import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { VerifiedTarball } from "./fetcher.js";
import { extractNpmJavaScriptCapabilities } from "./javascript-capability-extractor.js";
import { extractNpmManifestCapabilities } from "./manifest-capability-extractor.js";
import {
  ExtractorConfigurationError,
  extractVerifiedManifest,
  extractVerifiedTarball,
  type ExtractedTarball,
  type ExtractionResult,
} from "./safe-extractor.js";

async function withExtraction(
  pending: Promise<ExtractionResult>,
  body: (extraction: ExtractedTarball) => Promise<void> | void,
): Promise<void> {
  const result = await pending;
  if (result.status !== "extracted") {
    throw new Error(`expected extraction: ${result.failure.detail}`);
  }
  try {
    await body(result);
  } finally {
    await result.cleanup();
  }
}

interface TarEntry {
  path: string;
  body?: Uint8Array;
  type?: string;
  linkpath?: string;
  mode?: number;
}

function tarball(entries: readonly TarEntry[]): VerifiedTarball {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = entry.body ?? new Uint8Array();
    const header = new Uint8Array(512);
    writeString(header, entry.path, 0, 100);
    writeOctal(header, entry.mode ?? 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, body.byteLength, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeString(header, entry.linkpath ?? "", 157, 100);
    writeString(header, "ustar", 257, 6);
    writeString(header, "00", 263, 2);
    writeChecksum(header);
    blocks.push(header, body, new Uint8Array(padding(body.byteLength)));
  }
  blocks.push(new Uint8Array(1024));
  return {
    integrity: "sha512-fixture",
    bytes: gzipSync(concatenate(blocks)),
  };
}

function writeString(
  target: Uint8Array,
  value: string,
  offset: number,
  length: number,
): void {
  const encoded = new TextEncoder().encode(value);
  target.set(encoded.slice(0, length), offset);
}

function writeOctal(
  target: Uint8Array,
  value: number,
  offset: number,
  length: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  writeString(target, encoded, offset, length);
}

function writeChecksum(header: Uint8Array): void {
  const checksum = header.reduce((total, value) => total + value, 0);
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeString(header, encoded, 148, 8);
}

function padding(size: number): number {
  return (512 - (size % 512)) % 512;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function regularFile(path: string, text = "inert fixture"): TarEntry {
  return { path, body: new TextEncoder().encode(text) };
}

function directory(path: string): TarEntry {
  return { path, type: "5" };
}

/**
 * Encodes PAX extended-header records ("N key=value\n", where N is the whole
 * record's length). Fixture records are short, so one pass fixes the length.
 */
function paxBody(fields: Readonly<Record<string, string>>): Uint8Array {
  let body = "";
  for (const [key, value] of Object.entries(fields)) {
    const record = `${key}=${value}\n`;
    const length = record.length + String(record.length + 1).length + 1;
    body += `${String(length)} ${record}`;
  }
  return new TextEncoder().encode(body);
}

describe("extractVerifiedTarball", () => {
  it("manifest-preflights safely write only package.json", async () => {
    const result = await extractVerifiedManifest(
      tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        regularFile("package/index.js", "echo inert"),
      ]),
    );

    expect(result.status).toBe("extracted");
    if (result.status !== "extracted") throw new Error("expected extraction");
    expect(existsSync(`${result.root}/package.json`)).toBe(true);
    expect(existsSync(`${result.root}/index.js`)).toBe(false);
    await result.cleanup();
  });

  it("extracts only package/ contents into a private root and cleans it up", async () => {
    const result = await extractVerifiedTarball(
      tarball([regularFile("package/package.json", '{"name":"fixture"}')]),
    );

    expect(result.status).toBe("extracted");
    if (result.status !== "extracted") throw new Error("expected extraction");
    expect(result.fileCount).toBe(1);
    expect(result.expandedBytes).toBeGreaterThan(0);
    await expect(readFile(`${result.root}/package.json`, "utf8")).resolves.toBe(
      '{"name":"fixture"}',
    );
    const root = result.root;
    await result.cleanup();
    expect(existsSync(root)).toBe(false);
  });

  it.each([
    ["parent traversal", "package/../outside.txt"],
    ["absolute path", "/package/outside.txt"],
    ["Windows drive path", "C:/package/outside.txt"],
  ])("rejects %s before extraction", async (_label, path) => {
    const result = await extractVerifiedTarball(tarball([regularFile(path)]));
    expect(result).toMatchObject({
      status: "rejected",
      failure: { kind: "unsafe-path" },
    });
  });

  it.each([
    ["hard link", "1"],
    ["symbolic link", "2"],
  ])(
    "rejects a %s instead of relying on tar's link handling",
    async (_label, type) => {
      const result = await extractVerifiedTarball(
        tarball([
          {
            path: "package/link",
            type,
            linkpath: "../../outside",
          },
        ]),
      );
      expect(result).toMatchObject({
        status: "rejected",
        failure: { kind: "link-entry" },
      });
    },
  );

  it("rejects an archive with nothing beneath a top-level directory", async () => {
    // npm drops top-level files and bare roots, so nothing would be installed.
    const result = await extractVerifiedTarball(
      tarball([directory("node/"), regularFile("index.js")]),
    );
    expect(result).toMatchObject({
      status: "rejected",
      failure: { kind: "invalid-layout" },
    });
  });

  describe("npm strip-one layout semantics (ADR-013)", () => {
    const READ = (root: string, file: string) =>
      readFile(`${root}/${file}`, "utf8");

    it("rejects a file header ending in a slash (node-tar strict parse)", async () => {
      const result = await extractVerifiedTarball(
        tarball([
          regularFile("x/package.json", "{}"),
          regularFile("x/index.js/"),
        ]),
      );
      expect(result).toMatchObject({
        status: "rejected",
        failure: { kind: "invalid-archive" },
      });
    });

    it("extracts a non-package root with explicit directory entries, like @types/*", async () => {
      const archive = tarball([
        directory("node/"),
        regularFile("node/package.json", '{"name":"@types/fixture"}'),
        directory("node/sub/"),
        regularFile("node/sub/data.d.ts", "export {};"),
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(READ(root, "package.json")).resolves.toBe(
            '{"name":"@types/fixture"}',
          );
          await expect(READ(root, "sub/data.d.ts")).resolves.toBe("export {};");
        },
      );
      await withExtraction(extractVerifiedManifest(archive), ({ root }) => {
        expect(existsSync(`${root}/package.json`)).toBe(true);
        expect(existsSync(`${root}/sub`)).toBe(false);
      });
    });

    it.each([
      ["benign first, hook last", ["a", "b"], "b"],
      ["hook first, benign last", ["b", "a"], "a"],
    ] as const)(
      "merges mixed roots with the last manifest winning (%s)",
      async (_label, order, winner) => {
        const manifests = {
          a: '{"name":"fixture","version":"1.0.0"}',
          b: '{"name":"fixture","version":"1.0.0","scripts":{"postinstall":"node x.js"}}',
        };
        const archive = tarball(
          order.map((root) =>
            regularFile(`${root}/package.json`, manifests[root]),
          ),
        );
        for (const extract of [
          extractVerifiedTarball,
          extractVerifiedManifest,
        ]) {
          await withExtraction(extract(archive), async ({ root }) => {
            await expect(READ(root, "package.json")).resolves.toBe(
              manifests[winner],
            );
          });
        }
      },
    );

    it("keeps the last bytes for a colliding code file across roots", async () => {
      await withExtraction(
        extractVerifiedTarball(
          tarball([
            regularFile("a/package.json", "{}"),
            regularFile("a/index.js", "first"),
            regularFile("b/index.js", "last"),
          ]),
        ),
        async ({ root }) => {
          await expect(READ(root, "index.js")).resolves.toBe("last");
        },
      );
    });

    it.each([
      ["package.json", "a/package.json", "b/package.json/"],
      ["a code file", "a/index.js", "b/index.js/"],
    ])(
      "never lets a later directory header replace an installed %s",
      async (_label, file, shadow) => {
        // pacote ignores Directory headers, so npm keeps the file.
        const archive = tarball([
          regularFile("a/package.json", '{"name":"fixture","version":"1.0.0"}'),
          regularFile(file, "kept"),
          directory(shadow),
        ]);
        await withExtraction(
          extractVerifiedTarball(archive),
          async ({ root }) => {
            await expect(READ(root, file.slice(2))).resolves.toBe("kept");
          },
        );
      },
    );

    it("analyzes the retained code when a directory header tries to shadow it", async () => {
      const archive = tarball([
        regularFile("a/package.json", '{"name":"fixture","version":"1.0.0"}'),
        regularFile(
          "a/index.js",
          'const cp = require("node:child_process");\nmodule.exports = () => cp.spawnSync("capdelta-fixture-nonexistent-command");\n',
        ),
        directory("b/index.js/"),
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async (extraction) => {
          const manifest = await extractNpmManifestCapabilities(extraction, {
            ecosystem: "npm",
            name: "fixture",
            version: "1.0.0",
          });
          if (manifest.status !== "analyzed")
            throw new Error("manifest unavailable");
          const layer = await extractNpmJavaScriptCapabilities(
            extraction,
            manifest.set,
          );
          expect(
            layer.capabilities.map((capability) => capability.kind),
          ).toContain("PROCESS");
        },
      );
    });

    it("ignores a top-level file instead of using it as the manifest", async () => {
      const archive = tarball([
        regularFile("package.json", '{"name":"top-level-decoy"}'),
        regularFile("x/package.json", '{"name":"installed"}'),
      ]);
      for (const extract of [extractVerifiedTarball, extractVerifiedManifest]) {
        await withExtraction(extract(archive), async ({ root }) => {
          await expect(READ(root, "package.json")).resolves.toBe(
            '{"name":"installed"}',
          );
        });
      }
    });

    it.each([
      ["a doubled directory terminator", directory("x/sub//")],
      ["traversal in the stripped root", regularFile("../package.json")],
      ["traversal after the root", regularFile("x/../package.json")],
      ["a dot root", regularFile("./package.json")],
      ["a drive path exposed by stripping", regularFile("x/C:/package.json")],
      [
        "a drive-relative path exposed by stripping",
        regularFile("x/C:package.json"),
      ],
    ])("still rejects %s as unsafe in both passes", async (_label, entry) => {
      const archive = tarball([regularFile("x/package.json", "{}"), entry]);
      for (const extract of [extractVerifiedTarball, extractVerifiedManifest]) {
        await expect(extract(archive)).resolves.toMatchObject({
          status: "rejected",
          failure: { kind: "unsafe-path" },
        });
      }
    });
  });

  it("rejects file-count and expanded-size cap breaches during preflight", async () => {
    const tooManyFiles = await extractVerifiedTarball(
      tarball([regularFile("package/one.txt"), regularFile("package/two.txt")]),
      { maxFileCount: 1 },
    );
    expect(tooManyFiles).toMatchObject({
      status: "rejected",
      failure: { kind: "file-count-limit" },
    });

    const tooLarge = await extractVerifiedTarball(
      tarball([regularFile("package/large.txt", "four")]),
      { maxExpandedBytes: 3 },
    );
    expect(tooLarge).toMatchObject({
      status: "rejected",
      failure: { kind: "expanded-size-limit" },
    });
  });

  it("enforces the decompression-ratio cap before extraction", async () => {
    const result = await extractVerifiedTarball(
      tarball([regularFile("package/repetitive.txt", "A".repeat(8_192))]),
      { maxDecompressionRatio: 1 },
    );
    expect(result).toMatchObject({
      status: "rejected",
      failure: { kind: "decompression-ratio-limit" },
    });
  });

  it("rejects malformed archive bytes without creating an extraction root", async () => {
    const result = await extractVerifiedTarball({
      integrity: "sha512-fixture",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(result).toMatchObject({
      status: "rejected",
      failure: { kind: "invalid-archive" },
    });
  });

  it("rejects an aborted extraction with the run-level reason", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractVerifiedTarball(
        tarball([regularFile("package/index.js", "inert")]),
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      failure: { kind: "analysis-aborted" },
    });
  });

  it("throws for caps that would disable safe extraction", async () => {
    await expect(
      extractVerifiedTarball(tarball([]), { maxFileCount: 0 }),
    ).rejects.toBeInstanceOf(ExtractorConfigurationError);
  });

  describe("mode normalization (ADR-019)", () => {
    async function modeBits(path: string): Promise<number> {
      return (await stat(path)).mode & 0o7777;
    }

    it("makes a mode-000 file readable and stores it as 0o600", async () => {
      // node-tar creates the file with the archive mode when chmod is false,
      // so before ADR-019 an unprivileged runner could not read this index.js.
      const archive = tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        { ...regularFile("package/index.js", "inert fixture"), mode: 0o000 },
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(readFile(`${root}/index.js`, "utf8")).resolves.toBe(
            "inert fixture",
          );
          expect(await modeBits(`${root}/index.js`)).toBe(0o600);
        },
      );
    });

    it.each([
      ["setuid", 0o4755],
      ["setgid", 0o2755],
      ["sticky", 0o1755],
    ] as const)("strips the %s bit, storing 0o600", async (_label, mode) => {
      const archive = tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        { ...regularFile("package/index.js", "inert fixture"), mode },
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(readFile(`${root}/index.js`, "utf8")).resolves.toBe(
            "inert fixture",
          );
          expect(await modeBits(`${root}/index.js`)).toBe(0o600);
        },
      );
    });

    it("normalizes the manifest-only pass with the same filter", async () => {
      const archive = tarball([
        {
          ...regularFile("package/package.json", '{"name":"fixture"}'),
          mode: 0o000,
        },
        { ...regularFile("package/index.js", "inert fixture"), mode: 0o000 },
      ]);
      await withExtraction(
        extractVerifiedManifest(archive),
        async ({ root }) => {
          await expect(readFile(`${root}/package.json`, "utf8")).resolves.toBe(
            '{"name":"fixture"}',
          );
          expect(await modeBits(`${root}/package.json`)).toBe(0o600);
          expect(existsSync(`${root}/index.js`)).toBe(false);
        },
      );
    });

    it("normalizes an old-format file (NUL typeflag) stored with mode 000", async () => {
      // Old tar marks regular files with a NUL typeflag. node-tar 7.5.22
      // normalizes that to File (header.js: `this.#type = t || "0"`), so its
      // `OldFile` case in unpack is unreachable from an archive; this still
      // guards the old-format header path through the same filter.
      const archive = tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        {
          ...regularFile("package/index.js", "inert fixture"),
          type: "\0",
          mode: 0o000,
        },
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(readFile(`${root}/index.js`, "utf8")).resolves.toBe(
            "inert fixture",
          );
          expect(await modeBits(`${root}/index.js`)).toBe(0o600);
        },
      );
    });

    it("creates a traversable parent despite a mode-000 Directory header", async () => {
      const archive = tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        { ...directory("package/dir/"), mode: 0o000 },
        { ...regularFile("package/dir/x.js", "nested fixture"), mode: 0o000 },
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(readdir(`${root}/dir`)).resolves.toEqual(["x.js"]);
          await expect(readFile(`${root}/dir/x.js`, "utf8")).resolves.toBe(
            "nested fixture",
          );
          expect(await modeBits(`${root}/dir/x.js`)).toBe(0o600);
        },
      );
    });

    it("keeps the final bytes and 0o600 for a duplicate pathname", async () => {
      const archive = tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        { ...regularFile("package/index.js", "first"), mode: 0o644 },
        { ...regularFile("package/index.js", "last"), mode: 0o4755 },
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(readFile(`${root}/index.js`, "utf8")).resolves.toBe(
            "last",
          );
          expect(await modeBits(`${root}/index.js`)).toBe(0o600);
        },
      );
    });

    it("normalizes a mode supplied by a PAX extended header", async () => {
      const archive = tarball([
        regularFile("package/package.json", '{"name":"fixture"}'),
        {
          path: "PaxHeader/index.js",
          type: "x",
          body: paxBody({ mode: "0000000" }),
        },
        { ...regularFile("package/index.js", "inert fixture"), mode: 0o644 },
      ]);
      await withExtraction(
        extractVerifiedTarball(archive),
        async ({ root }) => {
          await expect(readFile(`${root}/index.js`, "utf8")).resolves.toBe(
            "inert fixture",
          );
          expect(await modeBits(`${root}/index.js`)).toBe(0o600);
        },
      );
    });
  });
});
