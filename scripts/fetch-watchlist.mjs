#!/usr/bin/env node
// Builds a watchlist from the npm-high-impact package. The package's tarball is
// read as text and never executed: npm pack runs with --ignore-scripts, and tar
// only writes lib/top.js to stdout.
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PACKAGE = "npm-high-impact";
const TOP_MODULE = "package/lib/top.js";
const MIN_PACKAGES = 1000;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;
const USAGE = "usage: node scripts/fetch-watchlist.mjs --top <n> -o <file>";

/**
 * Reads names from `lib/top.js` without evaluating it. The file exports one
 * array literal of quoted strings, so the parser takes that array's contents.
 * @param {string} source
 * @returns {string[]}
 */
export function parseTopJs(source) {
  const start = /const\s+top\s*=\s*\[/u.exec(source);
  if (start === null) {
    throw new Error("lib/top.js has no top array");
  }
  const open = start.index + start[0].length;
  const close = source.indexOf("]", open);
  if (close === -1) {
    throw new Error("lib/top.js has an unterminated top array");
  }
  const names = [];
  const quoted = /'([^'\\\n]*)'|"([^"\\\n]*)"/gu;
  for (const match of source.slice(open, close).matchAll(quoted)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) names.push(name);
  }
  return names;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const { top, output } = parseArguments(argv);
  const work = await mkdtemp(join(tmpdir(), "capdelta-watchlist-"));
  try {
    const tarball = await downloadTarball(work);
    const names = parseTopJs(await readTopModule(tarball));
    if (names.length < MIN_PACKAGES) {
      throw new Error(
        `${TOP_MODULE} has ${String(names.length)} package names; expected at least ${String(MIN_PACKAGES)}`,
      );
    }
    if (top > names.length) {
      throw new Error(
        `--top ${String(top)} exceeds the ${String(names.length)} package names in ${TOP_MODULE}`,
      );
    }
    const selected = names.slice(0, top);
    await writeWatchlist(output, `${selected.join("\n")}\n`);
    console.log(
      `wrote ${String(selected.length)} package names to ${JSON.stringify(output)}`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @returns {{ top: number, output: string }}
 */
function parseArguments(argv) {
  let top;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--top") {
      index += 1;
      top = argv[index];
    } else if (argument === "-o") {
      index += 1;
      output = argv[index];
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (top === undefined || !/^\d+$/u.test(top)) {
    throw new Error("--top must be a positive integer");
  }
  const count = Number(top);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("--top must be a positive integer");
  }
  if (output === undefined || output === "") {
    throw new Error("-o must name the output file");
  }
  return { top: count, output };
}

/**
 * Runs `npm pack --ignore-scripts`, which downloads the tarball without
 * running any lifecycle script from the package.
 * @param {string} work
 * @returns {Promise<string>}
 */
async function downloadTarball(work) {
  let stdout;
  try {
    ({ stdout } = await execFile(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        PACKAGE,
        "--pack-destination",
        work,
      ],
      { maxBuffer: MAX_COMMAND_BYTES },
    ));
  } catch (error) {
    throw new Error(`npm pack ${PACKAGE} failed: ${errorText(error)}`, {
      cause: error,
    });
  }
  const filename = packedFilename(stdout);
  const tarball = join(work, filename);
  try {
    const info = await stat(tarball);
    if (!info.isFile() || info.size === 0) {
      throw new Error("it is not a non-empty regular file");
    }
  } catch (error) {
    throw new Error(
      `npm pack wrote no readable ${filename}: ${errorText(error)}`,
      {
        cause: error,
      },
    );
  }
  return tarball;
}

/**
 * @param {string} stdout
 * @returns {string}
 */
function packedFilename(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack printed no JSON: ${errorText(error)}`, {
      cause: error,
    });
  }
  const filename =
    Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object"
      ? parsed[0]?.filename
      : undefined;
  if (typeof filename !== "string" || filename === "") {
    throw new Error("npm pack printed no tarball name");
  }
  if (
    basename(filename) !== filename ||
    !filename.startsWith(`${PACKAGE}-`) ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error(`npm pack printed an unexpected file name: ${filename}`);
  }
  return filename;
}

/**
 * @param {string} tarball
 * @returns {Promise<string>}
 */
async function readTopModule(tarball) {
  try {
    const { stdout } = await execFile(
      "tar",
      ["-x", "-O", "-f", tarball, TOP_MODULE],
      { maxBuffer: MAX_COMMAND_BYTES },
    );
    return stdout;
  } catch (error) {
    throw new Error(
      `tar could not read ${TOP_MODULE} from the tarball: ${errorText(error)}`,
      { cause: error },
    );
  }
}

/**
 * @param {string} output
 * @param {string} text
 */
async function writeWatchlist(output, text) {
  const temporary = join(
    dirname(output),
    `.${basename(output)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, output);
  } catch (error) {
    let detail = errorText(error);
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      detail = `${detail}; the temporary file also could not be removed: ${errorText(cleanupError)}`;
    }
    throw new Error(
      `cannot write watchlist ${JSON.stringify(output)}: ${detail}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error) {
    const stderr =
      "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const detail =
      stderr === "" ? error.message : `${error.message}: ${stderr}`;
    return detail.slice(0, 2000);
  }
  return String(error).slice(0, 2000);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`fetch-watchlist: ${errorText(error)}`);
    console.error(USAGE);
    process.exitCode = 1;
  });
}
