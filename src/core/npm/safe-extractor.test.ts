import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { VerifiedTarball } from "./fetcher.js";
import {
  ExtractorConfigurationError,
  extractVerifiedTarball,
} from "./safe-extractor.js";

interface TarEntry {
  path: string;
  body?: Uint8Array;
  type?: string;
  linkpath?: string;
}

/**
 * Minimal inert ustar writer for adversarial fixtures. It deliberately writes
 * paths node-tar itself refuses to create, so the extractor tests its own
 * defenses without ever executing package code.
 */
function tarball(entries: readonly TarEntry[]): VerifiedTarball {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = entry.body ?? new Uint8Array();
    const header = new Uint8Array(512);
    writeString(header, entry.path, 0, 100);
    writeOctal(header, 0o644, 100, 8);
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

describe("extractVerifiedTarball", () => {
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

  it("rejects an npm archive whose entries are not rooted under package/", async () => {
    const result = await extractVerifiedTarball(
      tarball([regularFile("index.js")]),
    );
    expect(result).toMatchObject({
      status: "rejected",
      failure: { kind: "invalid-layout" },
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
});
