import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeChangedPackages } from "../core/capability-analysis-pipeline.js";
import { diffNpmLockfiles } from "../core/npm/lockfile-differ.js";
import { renderJsonRunReport, renderTextRunReport } from "../core/reporter.js";
import {
  CliOperationalError,
  CliUsageError,
  terminalSafeError,
} from "./cli-errors.js";
import {
  CLI_HELP,
  parseCliArguments,
  USAGE_ERROR_EXIT_CODE,
} from "./cli-options.js";
import {
  inspectGitLockfileChange,
  readGitBaseLockfile,
} from "./git-lockfile-retriever.js";

export { CliError, CliOperationalError, CliUsageError } from "./cli-errors.js";

const LOCKFILE_NAME = "package-lock.json";
const DEFAULT_MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;

export interface CliRuntime {
  cwd: string;
  stdout(value: string): void;
  stderr(value: string): void;
  /** Test seam used for inert tarball responses; production uses global fetch. */
  fetchImpl?: typeof fetch;
  maxLockfileBytes?: number;
}

/** Converts all CLI outcomes into deterministic process exit codes and output. */
export async function executeCli(
  argv: readonly string[],
  runtime: CliRuntime,
): Promise<number> {
  try {
    const args = parseCliArguments(argv);
    if (args.help) {
      runtime.stdout(CLI_HELP);
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
    if (error instanceof CliUsageError) runtime.stderr(`\n${CLI_HELP}`);
    return exitCode;
  }
}

async function analyzeCheckout(
  base: string,
  format: "text" | "json",
  runtime: CliRuntime,
): Promise<void> {
  const maxLockfileBytes = resolveMaxLockfileBytes(runtime.maxLockfileBytes);
  const inspection = await inspectGitLockfileChange(base, runtime.cwd);
  if (!inspection.changed) return;

  const [baseText, headText] = await Promise.all([
    readGitBaseLockfile(inspection.commit, runtime.cwd, maxLockfileBytes),
    readHeadLockfile(runtime.cwd, maxLockfileBytes),
  ]);
  const oldLockfile =
    baseText === null ? null : parseLockfile(baseText, "base");
  const headLockfile = parseLockfile(headText, "head");
  const lockfileDiff = diffNpmLockfiles(oldLockfile, headLockfile);
  const analysis = await analyzeChangedPackages(
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

function resolveMaxLockfileBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_LOCKFILE_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CliOperationalError(
      "maxLockfileBytes must be a positive safe integer",
    );
  }
  return resolved;
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

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new CliOperationalError(`${description} is not valid UTF-8`, {
      cause: error,
    });
  }
}
