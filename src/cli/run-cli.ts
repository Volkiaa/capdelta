import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeManifestPackages } from "../core/manifest-analysis-pipeline.js";
import { diffNpmLockfiles } from "../core/npm/lockfile-differ.js";
import { renderJsonRunReport, renderTextRunReport } from "../core/reporter.js";

const LOCKFILE_NAME = "package-lock.json";
const DEFAULT_MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;
const GIT_METADATA_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 500;
const MAX_ERROR_CHAIN_LENGTH = 3;
/** BSD sysexits EX_USAGE; PLAN §4.5 reserves exit 2 for future --strict. */
const USAGE_ERROR_EXIT_CODE = 64;

const HELP = [
  "Usage: capdelta --base <ref> [--format text|json]",
  "",
  "Compare the checkout's package-lock.json with a Git base revision.",
  "",
  "Options:",
  "  --base <ref>          Git revision used as the baseline (required)",
  "  --format text|json    Report format (default: text)",
  "  --help                Show this help",
  "",
].join("\n");

export interface CliRuntime {
  cwd: string;
  stdout(value: string): void;
  stderr(value: string): void;
  /** Test seam used for inert tarball responses; production uses global fetch. */
  fetchImpl?: typeof fetch;
  maxLockfileBytes?: number;
}

export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CliUsageError extends CliError {}

export class CliOperationalError extends CliError {}

interface CliArguments {
  help: boolean;
  base: string | null;
  format: "text" | "json";
}

interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

/** Converts all CLI outcomes into deterministic process exit codes and output. */
export async function executeCli(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<number> {
  try {
    const args = parseArguments(argv);
    if (args.help) {
      runtime.stdout(HELP);
      return 0;
    }
    if (args.base === null) {
      throw new CliUsageError("--base <ref> is required");
    }
    await analyzeCheckout(args.base, args.format, runtime);
    return 0;
  } catch (error: unknown) {
    const exitCode = error instanceof CliUsageError ? USAGE_ERROR_EXIT_CODE : 1;
    runtime.stderr(`capdelta: ${terminalSafeError(error)}\n`);
    if (error instanceof CliUsageError) runtime.stderr(`\n${HELP}`);
    return exitCode;
  }
}

async function analyzeCheckout(
  base: string,
  format: "text" | "json",
  runtime: CliRuntime,
): Promise<void> {
  const maxLockfileBytes = resolveMaxLockfileBytes(runtime.maxLockfileBytes);
  const commit = await resolveBaseCommit(base, runtime.cwd);
  if (!(await lockfileChanged(commit, runtime.cwd))) return;

  const [baseText, headText] = await Promise.all([
    readBaseLockfile(commit, runtime.cwd, maxLockfileBytes),
    readHeadLockfile(runtime.cwd, maxLockfileBytes),
  ]);
  const oldLockfile =
    baseText === null ? null : parseLockfile(baseText, "base");
  const headLockfile = parseLockfile(headText, "head");
  const lockfileDiff = diffNpmLockfiles(oldLockfile, headLockfile);
  const analysis = await analyzeManifestPackages(
    lockfileDiff,
    runtime.fetchImpl === undefined
      ? {}
      : { fetcher: { fetchImpl: runtime.fetchImpl } },
  );
  runtime.stdout(
    format === "json"
      ? renderJsonRunReport(analysis)
      : renderTextRunReport(analysis),
  );
}

function parseArguments(argv: readonly string[]): CliArguments {
  let help = false;
  let base: string | null = null;
  let format: "text" | "json" = "text";
  let formatSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--base") {
      if (base !== null)
        throw new CliUsageError("--base may only be provided once");
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new CliUsageError("--base requires a Git revision");
      }
      base = value;
      index += 1;
      continue;
    }
    if (argument === "--format") {
      if (formatSeen) {
        throw new CliUsageError("--format may only be provided once");
      }
      const value = argv[index + 1];
      if (value !== "text" && value !== "json") {
        throw new CliUsageError("--format must be text or json");
      }
      format = value;
      formatSeen = true;
      index += 1;
      continue;
    }
    throw new CliUsageError(`unknown argument ${JSON.stringify(argument)}`);
  }

  return { help, base, format };
}

function resolveMaxLockfileBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_LOCKFILE_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CliOperationalError(
      "maxLockfileBytes must be a positive safe integer",
    );
  }
  return resolved;
}

async function resolveBaseCommit(base: string, cwd: string): Promise<string> {
  const result = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (result.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot resolve base revision ${JSON.stringify(base)}: ${gitDetail(result)}`,
    );
  }
  const commit = decodeUtf8(result.stdout, "Git commit output").trim();
  if (!/^[0-9a-f]{40,64}$/iu.test(commit)) {
    throw new CliOperationalError("Git returned an invalid base commit ID");
  }
  return commit;
}

async function lockfileChanged(commit: string, cwd: string): Promise<boolean> {
  const tracked = await runGit(
    ["diff", "--quiet", "--no-ext-diff", commit, "--", LOCKFILE_NAME],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (tracked.exitCode === 1) return true;
  if (tracked.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot compare ${LOCKFILE_NAME} with the base revision: ${gitDetail(tracked)}`,
    );
  }

  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard", "--", LOCKFILE_NAME],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (untracked.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot inspect untracked ${LOCKFILE_NAME}: ${gitDetail(untracked)}`,
    );
  }
  return untracked.stdout.length > 0;
}

async function readBaseLockfile(
  commit: string,
  cwd: string,
  maxBytes: number,
): Promise<string | null> {
  const tree = await runGit(
    ["ls-tree", "-z", commit, "--", LOCKFILE_NAME],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (tree.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot inspect base ${LOCKFILE_NAME}: ${gitDetail(tree)}`,
    );
  }
  if (tree.stdout.length === 0) return null;
  const metadata = decodeUtf8(tree.stdout, `base ${LOCKFILE_NAME} metadata`);
  const blobId =
    /^100\d{3} blob ([0-9a-f]{40,64})\tpackage-lock\.json\0$/iu.exec(
      metadata,
    )?.[1];
  if (blobId === undefined) {
    throw new CliOperationalError(
      `base ${LOCKFILE_NAME} is not a regular Git blob`,
    );
  }

  // Read the exact object whose mode and type were validated above. Using
  // `<commit>:<path>` here would resolve the path from the repository root,
  // while ls-tree and the head lockfile are relative to cwd.
  const shown = await runGit(["cat-file", "blob", blobId], cwd, maxBytes);
  if (shown.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot read base ${LOCKFILE_NAME}: ${gitDetail(shown)}`,
    );
  }
  return decodeUtf8(shown.stdout, `base ${LOCKFILE_NAME}`);
}

async function readHeadLockfile(
  cwd: string,
  maxBytes: number,
): Promise<string> {
  const path = resolve(cwd, LOCKFILE_NAME);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw new CliOperationalError(`cannot inspect head ${LOCKFILE_NAME}`, {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CliOperationalError(
      `head ${LOCKFILE_NAME} must be a regular file, not a symlink`,
    );
  }
  if (metadata.size > maxBytes) {
    throw new CliOperationalError(
      `head ${LOCKFILE_NAME} exceeds the ${String(maxBytes)} byte limit`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    throw new CliOperationalError(`cannot read head ${LOCKFILE_NAME}`, {
      cause: error,
    });
  }
  if (bytes.length > maxBytes) {
    throw new CliOperationalError(
      `head ${LOCKFILE_NAME} exceeds the ${String(maxBytes)} byte limit`,
    );
  }
  return decodeUtf8(bytes, `head ${LOCKFILE_NAME}`);
}

function parseLockfile(text: string, side: "base" | "head"): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new CliOperationalError(
      `${side} ${LOCKFILE_NAME} is not valid JSON`,
      { cause: error },
    );
  }
}

async function runGit(
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;

    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.once("error", (error) => {
      reject(new CliOperationalError("cannot start Git", { cause: error }));
    });
    child.once("close", (code) => {
      if (outputExceeded) {
        reject(
          new CliOperationalError(
            `Git output exceeds the ${String(maxOutputBytes)} byte limit`,
          ),
        );
        return;
      }
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function gitDetail(result: GitResult): string {
  const detail = decodeUtf8(result.stderr, "Git error output").trim();
  return detail.length === 0
    ? `Git exited ${String(result.exitCode)}`
    : truncate(detail, MAX_ERROR_CHARS);
}

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new CliOperationalError(`${description} is not valid UTF-8`, {
      cause: error,
    });
  }
}

function terminalSafeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CHAIN_LENGTH; depth += 1) {
    if (seen.has(current)) {
      messages.push("caused by [cycle]");
      break;
    }
    seen.add(current);
    messages.push(`${depth === 0 ? "" : "caused by "}${errorSummary(current)}`);
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  const message = messages.join("; ");
  const escaped = JSON.stringify(truncate(message, MAX_ERROR_CHARS));
  return escaped.slice(1, -1);
}

function errorSummary(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error;
}

function truncate(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}
