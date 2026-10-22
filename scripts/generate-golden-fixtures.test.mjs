import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandPadding,
  rewriteAsciiUstarEntryModes,
  validateEntryLinks,
} from "./generate-golden-fixtures.mjs";

let workDir;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "capdelta-golden-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Builds one 512-byte ustar header. Numeric fields are octal ASCII strings,
 * which is what `tar.c({ portable: true })` writes.
 */
function ustarHeader({ name, typeflag, size = "00000000000" }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write(typeflag, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  return header;
}

async function writeTarball(buffer) {
  const tarball = join(workDir, "archive.tgz");
  await writeFile(tarball, gzipSync(buffer));
  return tarball;
}

describe("rewriteAsciiUstarEntryModes", () => {
  it("throws on a PAX extended header", async () => {
    const header = ustarHeader({
      name: "PaxHeaders/pkg",
      typeflag: "x",
      size: "00000000010",
    });
    const tarball = await writeTarball(
      Buffer.concat([header, Buffer.alloc(512)]),
    );

    await expect(
      rewriteAsciiUstarEntryModes(tarball, { "pkg/index.js": "600" }),
    ).rejects.toThrow(/PAX/u);
  });

  it("throws on a base-256 numeric field", async () => {
    const header = ustarHeader({ name: "pkg/index.js", typeflag: "0" });
    header[124] = 0x80;
    const tarball = await writeTarball(
      Buffer.concat([header, Buffer.alloc(512)]),
    );

    await expect(
      rewriteAsciiUstarEntryModes(tarball, { "pkg/index.js": "600" }),
    ).rejects.toThrow(/base-256/u);
  });

  it("rewrites the mode of a plain ustar entry", async () => {
    const source = join(workDir, "source");
    await mkdir(join(source, "pkg"), { recursive: true });
    await writeFile(join(source, "pkg/index.js"), "module.exports = 1;\n");
    const tarball = join(workDir, "plain.tgz");
    await tar.c(
      {
        cwd: source,
        file: tarball,
        gzip: true,
        portable: true,
        mtime: new Date(0),
      },
      ["pkg"],
    );

    await rewriteAsciiUstarEntryModes(tarball, { "pkg/index.js": "600" });

    const modes = new Map();
    await tar.t({
      file: tarball,
      onentry: (entry) => modes.set(entry.path, entry.mode),
    });
    expect(modes.get("pkg/index.js") & 0o777).toBe(0o600);
  });
});

describe("expandPadding", () => {
  it("replaces the marker with a block comment at the requested size", () => {
    const content = "const x = 1;\n/* PAD */\n";
    const expanded = expandPadding(content, "/* PAD */", 4_096);

    expect(expanded.startsWith("const x = 1;\n/*")).toBe(true);
    expect(expanded.endsWith("*/\n")).toBe(true);
    expect(expanded).not.toContain("PAD");
    expect(expanded.length).toBeGreaterThanOrEqual(4_096);
  });

  it("rejects a marker that is absent or repeated", () => {
    expect(() => expandPadding("no marker", "/* PAD */", 10)).toThrow(
      /exactly once/u,
    );
    expect(() => expandPadding("/* PAD *//* PAD */", "/* PAD */", 10)).toThrow(
      /exactly once/u,
    );
  });
});

describe("validateEntryLinks", () => {
  it("accepts a plain link inside the package", () => {
    expect(() =>
      validateEntryLinks([["package/link", "/etc/inert-target"]]),
    ).not.toThrow();
  });

  it.each([
    ["../escape", "target"],
    ["package/../escape", "target"],
    ["/abs/link", "target"],
    ["package/./link", "target"],
    ["package\\link", "target"],
    ["", "target"],
  ])("rejects the link path %j", (path, target) => {
    expect(() => validateEntryLinks([[path, target]])).toThrow(
      /invalid fixture entry link/u,
    );
  });

  it("rejects a link placed under another link", () => {
    expect(() =>
      validateEntryLinks([
        ["package/link", "/tmp/existing-dir"],
        ["package/link/payload", "target"],
      ]),
    ).toThrow(/sits under link/u);
  });
});
