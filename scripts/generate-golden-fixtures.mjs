import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import * as tar from "tar";

const BLOCK_SIZE = 512;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

// Numeric field offsets in a 512-byte ustar header (POSIX.1-2017).
const USTAR_NUMERIC_FIELDS = [
  ["mode", 100],
  ["uid", 108],
  ["gid", 116],
  ["size", 124],
  ["mtime", 136],
  ["devmajor", 329],
  ["devminor", 337],
];

async function main() {
  const goldenRoot = fileURLToPath(
    new URL("../test/fixtures/golden/", import.meta.url),
  );
  const cases = JSON.parse(
    await readFile(join(goldenRoot, "cases.json"), "utf8"),
  );
  const only = process.argv[2];

  for (const goldenCase of cases.filter(
    (item) => only === undefined || item.name === only,
  )) {
    const caseRoot = join(goldenRoot, goldenCase.name);
    const integrities = {};
    for (const version of ["v1", "v2"]) {
      const tarball = join(caseRoot, `${version}.tgz`);
      await packTree(
        join(caseRoot, `source-${version}`),
        tarball,
        goldenCase.entryLinks?.[version],
      );
      integrities[version] = await sri(tarball);
    }
    if (goldenCase.mode !== "package") {
      await writeLockfile(
        join(caseRoot, "old-lockfile.json"),
        goldenCase,
        goldenCase.oldVersion,
        goldenCase.oldResolvedUrl,
        integrities.v1,
      );
      await writeLockfile(
        join(caseRoot, "new-lockfile.json"),
        goldenCase,
        goldenCase.newVersion,
        goldenCase.newResolvedUrl,
        integrities.v2,
      );
    }
  }

  const reconstructionRoot = fileURLToPath(
    new URL("../test/fixtures/reconstructions/", import.meta.url),
  );
  const inventory = JSON.parse(
    await readFile(join(reconstructionRoot, "inventory.json"), "utf8"),
  );

  for (const incident of inventory.incidents.filter(
    (item) => only === undefined || item.name === only,
  )) {
    const incidentRoot = join(reconstructionRoot, incident.name);
    const ids = [
      ...new Set(
        Object.values(incident.scenarios).flatMap((scenario) => [
          ...scenario.base,
          ...scenario.head,
        ]),
      ),
    ].sort();
    const entries = {};
    for (const id of ids) {
      const sourceRoot = join(incidentRoot, "packages", id);
      const tarball = join(incidentRoot, "packages", `${id}.tgz`);
      await packTree(
        sourceRoot,
        tarball,
        incident.entryLinks?.[id],
        paddingFor(incident, id),
      );
      const entryModes = incident.entryModes?.[id];
      if (entryModes !== undefined) {
        for (const [path, declared] of Object.entries(entryModes)) {
          if (
            !/^[0-7]{1,4}$/u.test(declared) ||
            Number.parseInt(declared, 8) > 0o7777
          ) {
            throw new Error(
              `entryModes for ${id} entry ${path} must be 1-4 octal digits <= 7777, got ${JSON.stringify(declared)}`,
            );
          }
        }
        await rewriteAsciiUstarEntryModes(tarball, entryModes);
      }
      // ADR-019
      const manifest =
        incident.packageMeta?.[id] ??
        JSON.parse(
          await readFile(
            join(sourceRoot, await soleRoot(sourceRoot), "package.json"),
            "utf8",
          ),
        );
      const basename = manifest.name.split("/").pop();
      entries[id] = {
        name: manifest.name,
        entry: {
          version: manifest.version,
          resolved: `https://registry.npmjs.org/${manifest.name}/-/${basename}-${manifest.version}.tgz`,
          integrity: await sri(tarball),
          ...(manifest.dependencies === undefined
            ? {}
            : { dependencies: manifest.dependencies }),
          // npm records this flag for packages with registry install hooks.
          ...(INSTALL_HOOKS.some(
            (hook) => manifest.scripts?.[hook] !== undefined,
          )
            ? { hasInstallScript: true }
            : {}),
        },
      };
    }
    for (const [scenario, sides] of Object.entries(incident.scenarios)) {
      for (const side of ["base", "head"]) {
        const packages = {
          "": { name: "reconstruction-project", version: "1.0.0" },
        };
        for (const id of sides[side]) {
          packages[`node_modules/${entries[id].name}`] = entries[id].entry;
        }
        const lockfile = {
          name: "reconstruction-project",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages,
        };
        await writeFile(
          join(incidentRoot, `${scenario}-${side}-lockfile.json`),
          `${JSON.stringify(lockfile, null, 2)}\n`,
          "utf8",
        );
      }
    }
  }
}

function paddingFor(incident, id) {
  return incident.padding?.[id];
}

async function packTree(sourceRoot, tarball, entryLinks = {}, padding = []) {
  const files = (await topLevelRoots(sourceRoot)).flatMap((items) => items);
  const links = Object.entries(entryLinks);
  if (links.length === 0 && padding.length === 0) {
    await tar.c(
      {
        cwd: sourceRoot,
        file: tarball,
        gzip: true,
        portable: true,
        mtime: new Date(0),
      },
      files,
    );
    return;
  }
  // Stage the declared links in a scratch copy so the source tree stays
  // regular-file-only and no symlink is followed or kept. Padding is expanded
  // only in the staging copy, so the committed fixture keeps the marker.
  validateEntryLinks(links);
  const work = await mkdtemp(join(tmpdir(), "capdelta-pack-"));
  try {
    const staging = join(work, "source");
    await cp(sourceRoot, staging, { recursive: true });
    for (const item of padding) {
      const target = stagedPath(staging, item.path);
      const content = await readFile(target, "utf8");
      await writeFile(target, expandPadding(content, item.marker, item.bytes));
    }
    for (const [path, target] of links) {
      await assertRealDirectories(staging, path);
      await symlink(target, join(staging, path));
    }
    await tar.c(
      {
        cwd: staging,
        file: tarball,
        gzip: true,
        portable: true,
        mtime: new Date(0),
      },
      [...files, ...links.map(([path]) => path)],
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const PADDING_BLOCK = paddingBlock(12_288);

/**
 * Replaces one marker with a block comment large enough for the file to reach
 * `minimumBytes`. The body repeats a varied block: a constant run compresses
 * about 1000:1, which the extractor's decompression-ratio cap rejects as a zip
 * bomb. Twelve KiB keeps the ratio near 85 while the tarball stays under 100 KB.
 */
export function expandPadding(content, marker, minimumBytes) {
  if (typeof marker !== "string" || marker.length === 0) {
    throw new Error("fixture padding marker must be a non-empty string");
  }
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes <= 0) {
    throw new Error(
      `fixture padding bytes must be a positive safe integer, got ${String(minimumBytes)}`,
    );
  }
  const at = content.indexOf(marker);
  if (at === -1 || content.indexOf(marker, at + marker.length) !== -1) {
    throw new Error(
      `fixture padding marker ${JSON.stringify(marker)} must occur exactly once`,
    );
  }
  const before = content.slice(0, at);
  const after = content.slice(at + marker.length);
  const bodyBytes = Math.max(
    0,
    minimumBytes - before.length - after.length - 4,
  );
  const body = PADDING_BLOCK.repeat(
    Math.ceil(bodyBytes / PADDING_BLOCK.length),
  );
  return `${before}/*${body.slice(0, bodyBytes)}*/${after}`;
}

function paddingBlock(length) {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = 0x9e3779b9;
  let block = "";
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    block += alphabet.charAt(state % alphabet.length);
  }
  return block;
}

function stagedPath(staging, path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("fixture padding path must be a non-empty string");
  }
  const target = resolve(staging, path);
  if (!target.startsWith(`${resolve(staging)}${sep}`)) {
    throw new Error(`fixture padding path escapes the source tree: ${path}`);
  }
  return target;
}

const LINK_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

/**
 * Symlinks are created on disk to pack them, so a link path must stay inside
 * the staging copy: plain relative segments, no `..`, and no link under
 * another link, which symlink() would follow out of the staging directory.
 */
export function validateEntryLinks(links) {
  const paths = links.map(([path]) => path);
  for (const [path, target] of links) {
    if (
      typeof path !== "string" ||
      typeof target !== "string" ||
      !path.split("/").every((segment) => LINK_PATH_SEGMENT.test(segment))
    ) {
      throw new Error(`invalid fixture entry link ${JSON.stringify(path)}`);
    }
    const nested = paths.find(
      (other) => other !== path && path.startsWith(`${other}/`),
    );
    if (nested !== undefined) {
      throw new Error(
        `fixture entry link ${JSON.stringify(path)} sits under link ${JSON.stringify(nested)}`,
      );
    }
  }
}

async function assertRealDirectories(staging, path) {
  const segments = path.split("/").slice(0, -1);
  let current = staging;
  for (const segment of segments) {
    current = join(current, segment);
    if (!(await lstat(current)).isDirectory()) {
      throw new Error(
        `fixture entry link parent ${JSON.stringify(current)} is not a real directory`,
      );
    }
  }
}

export async function rewriteAsciiUstarEntryModes(tarball, entryModes) {
  const remaining = new Map(Object.entries(entryModes));
  const buf = gunzipSync(await readFile(tarball));
  let offset = 0;
  while (offset + BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      offset += BLOCK_SIZE;
      continue;
    }
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x" || type === "g") {
      throw new Error(
        `rewriteAsciiUstarEntryModes cannot rewrite the PAX extended header ` +
          `(typeflag ${JSON.stringify(type)}) in ${tarball}`,
      );
    }
    for (const [field, start] of USTAR_NUMERIC_FIELDS) {
      if ((header[start] & 0x80) !== 0) {
        throw new Error(
          `rewriteAsciiUstarEntryModes cannot rewrite the base-256 numeric ` +
            `field ${field} in ${tarball}`,
        );
      }
    }
    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 500);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const size = Number.parseInt(cString(header, 124, 136).trim() || "0", 8);
    const declared = remaining.get(path);
    if (declared !== undefined) {
      if (type !== "0" && type !== "\0") {
        throw new Error(`entryModes target ${path} is not a regular file`);
      }
      writeOctalField(header, Number.parseInt(declared, 8), 100, 8);
      writeChecksum(header);
      remaining.delete(path);
    }
    offset += BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  if (remaining.size > 0) {
    throw new Error(
      `entryModes did not match archive entries: ${[...remaining.keys()].join(", ")}`,
    );
  }
  await writeFile(tarball, gzipSync(buf));
}

function cString(header, start, end) {
  // ustar name/prefix fields are byte strings; fixture paths are ASCII.
  let text = "";
  for (let index = start; index < end; index += 1) {
    const byte = header[index];
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

function writeOctalField(header, value, start, length) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  for (let index = 0; index < encoded.length; index += 1) {
    header[start + index] = encoded.charCodeAt(index);
  }
}

function writeChecksum(header) {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  for (let index = 0; index < encoded.length; index += 1) {
    header[148 + index] = encoded.charCodeAt(index);
  }
}

async function soleRoot(sourceRoot) {
  const roots = await readdir(sourceRoot);
  if (roots.length !== 1) {
    throw new Error(`${sourceRoot} must contain exactly one root directory`);
  }
  return roots[0];
}

async function topLevelRoots(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const roots = entries
    .map((entry) => {
      if (!entry.isDirectory()) {
        throw new Error(`fixture root entry ${entry.name} is not a directory`);
      }
      return entry.name;
    })
    .sort();
  return Promise.all(roots.map((root) => listRegularFiles(sourceRoot, root)));
}

async function sri(tarball) {
  return `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
}

async function listRegularFiles(root, relative) {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    // Dirent types describe the entry itself; symlinks are never followed.
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`golden fixture ${path} is not a regular file`);
    }
  }
  return files;
}

async function writeLockfile(path, goldenCase, version, resolved, integrity) {
  const lockfile = {
    name: "golden-lockfile-project",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "golden-lockfile-project", version: "1.0.0" },
      [`node_modules/${goldenCase.packageName}`]: {
        version,
        resolved,
        integrity,
      },
    },
  };
  await writeFile(path, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
