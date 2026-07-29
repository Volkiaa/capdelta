import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
  type CapabilityAnalysisRun,
} from "../core/capability-analysis-pipeline.js";
import {
  emptyCapdeltaConfig,
  parseCapdeltaConfig,
} from "../core/capdelta-config.js";
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
  STRICT_ANALYSIS_EXIT_CODE,
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
    const analysis = await analyzeCheckout(
      args.base,
      args.format,
      args.configPath ?? ".capdelta.yml",
      args.configPath === null,
      runtime,
    );
    if (args.strict && analysis !== null && hasUnanalyzedContent(analysis)) {
      runtime.stderr("capdelta: strict mode found unanalyzed content\n");
      return STRICT_ANALYSIS_EXIT_CODE;
    }
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
  configPath: string,
  allowMissingConfig: boolean,
  runtime: CliRuntime,
): Promise<CapabilityAnalysisRun | null> {
  const maxLockfileBytes = resolveMaxLockfileBytes(runtime.maxLockfileBytes);
  const inspection = await inspectGitLockfileChange(base, runtime.cwd);
  if (!inspection.changed) return null;

  const [baseText, headText] = await Promise.all([
    readGitBaseLockfile(inspection.commit, runtime.cwd, maxLockfileBytes),
    readHeadLockfile(runtime.cwd, maxLockfileBytes),
  ]);
  const oldLockfile =
    baseText === null ? null : parseLockfile(baseText, "base");
  const headLockfile = parseLockfile(headText, "head");
  const config = await readConfig(runtime.cwd, configPath, allowMissingConfig);
  const lockfileDiff = diffNpmLockfiles(oldLockfile, headLockfile);
  const analysis = await analyzeChangedPackages(
    lockfileDiff,
    runtime.fetchImpl === undefined
      ? { config }
      : { fetcher: { fetchImpl: runtime.fetchImpl }, config },
  );
  runtime.stdout(
    format === "json"
      ? renderJsonRunReport(analysis)
      : renderTextRunReport(analysis),
  );
  return analysis;
}

async function readConfig(
  cwd: string,
  configPath: string,
  allowMissing: boolean,
): Promise<ReturnType<typeof emptyCapdeltaConfig>> {
  const path = resolve(cwd, configPath);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if (allowMissing && isMissing(error)) return emptyCapdeltaConfig();
    throw new CliOperationalError(`cannot inspect config ${configPath}`, {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CliOperationalError(
      `config ${configPath} must be a regular file, not a symlink`,
    );
  }
  const maxBytes = 256 * 1024;
  if (metadata.size > maxBytes) {
    throw new CliOperationalError(
      `config ${configPath} exceeds the ${String(maxBytes)} byte limit`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error: unknown) {
    throw new CliOperationalError(`cannot read config ${configPath}`, {
      cause: error,
    });
  }
  if (bytes.length > maxBytes) {
    throw new CliOperationalError(
      `config ${configPath} exceeds the ${String(maxBytes)} byte limit`,
    );
  }
  try {
    return parseCapdeltaConfig(decodeUtf8(bytes, `config ${configPath}`));
  } catch (error: unknown) {
    throw new CliOperationalError(`config ${configPath} is invalid`, {
      cause: error,
    });
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
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
