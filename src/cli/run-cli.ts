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
import {
  IntelClientConfigurationError,
  lookupIntel,
  validateIntelUrl,
} from "../core/intel-client.js";
import { intelMatches } from "../core/intel-match.js";
import {
  readRegularFile,
  readRegularFileOperation,
  type ReadRegularFileResult,
} from "../core/read-regular-file.js";
import {
  buildRunReport,
  formatJsonRunReport,
  formatTextRunReport,
  type JsonRunReport,
} from "../core/reporter.js";
import {
  evaluateSeverityGate,
  hasOperationalFailure,
  operationalFailureCount,
  operationalFailureMessage,
} from "../core/run-severity.js";
import {
  CliOperationalError,
  CliUsageError,
  decodeUtf8,
  terminalSafeError,
  terminalSafeText,
} from "./cli-errors.js";
import {
  CLI_HELP,
  parseCliArguments,
  STRICT_ANALYSIS_EXIT_CODE,
  USAGE_ERROR_EXIT_CODE,
} from "./cli-options.js";
import {
  inspectGitLockfileChange,
  pathChanged,
  readGitBaseFile,
  readGitBaseLockfile,
} from "./git-lockfile-retriever.js";

export { CliError, CliOperationalError, CliUsageError } from "./cli-errors.js";

const LOCKFILE_NAME = "package-lock.json";
const DEFAULT_MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;

export interface CliRuntime {
  cwd: string;
  stdout(value: string): void;
  stderr(value: string): void;
  fetchImpl?: typeof fetch;
  /** ADR-018 test seam: injectable backoff, so retry tests never wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxLockfileBytes?: number;
  /**
   * ADR-019 test seam: replaces the analysis pipeline so entry-point tests can
   * inject the environmental stage failures (a residual filesystem error, an
   * unreadable manifest) that inert bytes cannot reproduce. Production never
   * sets it.
   */
  analyze?: typeof analyzeChangedPackages;
}

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
    const intelUrl =
      args.intelUrl === null ? null : validateIntelUrl(args.intelUrl).href;
    const analysis = await analyzeCheckout(
      args.base,
      args.format,
      args.configPath ?? ".capdelta.yml",
      args.configPath === null,
      intelUrl,
      runtime,
    );
    // Unchanged lockfile: the PLAN §2 fast path has nothing to gate.
    if (analysis === null) return 0;

    // The report is already delivered; gate, strict, and operational failure
    // only pick the exit.
    const gate = evaluateSeverityGate(analysis.report, args.failOn);
    if (gate.fail) {
      runtime.stderr(
        `capdelta: ${String(gate.matchingCount)} finding(s) at or above ${args.failOn} (highest: ${gate.highest ?? "none"})\n`,
      );
    }
    // ADR-018: a transient fetch failure that outlived its retries, or a
    // deadline/cancellation stop, fails the run even in report-only mode.
    const operationalCount = operationalFailureCount(analysis.run);
    const operationalFailure = hasOperationalFailure(analysis.run);
    if (operationalFailure) {
      runtime.stderr(`${operationalFailureMessage(operationalCount)}\n`);
    }
    if (args.strict && hasUnanalyzedContent(analysis.run)) {
      runtime.stderr("capdelta: strict mode found unanalyzed content\n");
      // PLAN §4.5 promises exit 2 for unanalyzed content, even when the
      // severity gate or an operational failure also failed; stderr above
      // still names every cause.
      return STRICT_ANALYSIS_EXIT_CODE;
    }
    return gate.fail || operationalFailure ? 1 : 0;
  } catch (error: unknown) {
    // A service URL the operator typed is a usage error, not a check result.
    const exitCode =
      error instanceof CliUsageError ||
      error instanceof IntelClientConfigurationError
        ? USAGE_ERROR_EXIT_CODE
        : 1;
    runtime.stderr(
      `capdelta: ${
        error instanceof IntelClientConfigurationError
          ? terminalSafeText(error.message)
          : terminalSafeError(error)
      }\n`,
    );
    if (error instanceof CliUsageError) runtime.stderr(`\n${CLI_HELP}`);
    return exitCode;
  }
}

async function analyzeCheckout(
  base: string,
  format: "text" | "json",
  configPath: string,
  allowMissingConfig: boolean,
  intelUrl: string | null,
  runtime: CliRuntime,
): Promise<{ run: CapabilityAnalysisRun; report: JsonRunReport } | null> {
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
  const config = await readBaseConfig(
    inspection.commit,
    runtime,
    configPath,
    allowMissingConfig,
  );
  const lockfileDiff = diffNpmLockfiles(oldLockfile, headLockfile, {
    registryHosts: config.registryHosts,
  });
  if (intelUrl !== null) {
    // The feed URL is a CLI argument only. Reading it from .capdelta.yml would
    // let a pull request point the check at a feed that never matches (ADR-015).
    const intel = await lookupIntel(lockfileDiff.changed, {
      baseUrl: intelUrl,
      ...(runtime.fetchImpl === undefined
        ? {}
        : { fetchImpl: runtime.fetchImpl }),
    });
    for (const warning of intel.warnings) {
      runtime.stderr(`capdelta: warning: ${terminalSafeText(warning)}\n`);
    }
    // A loop, not a spread: argument spreading has a stack limit.
    for (const match of intelMatches(lockfileDiff.changed, intel.findings)) {
      lockfileDiff.findings.push(match);
    }
  }
  const analyze = runtime.analyze ?? analyzeChangedPackages;
  const analysis = await analyze(lockfileDiff, {
    fetcher: {
      ...(runtime.fetchImpl === undefined
        ? {}
        : { fetchImpl: runtime.fetchImpl }),
      ...(runtime.sleep === undefined ? {} : { sleep: runtime.sleep }),
    },
    config,
  });
  const report = buildRunReport(analysis);
  runtime.stdout(
    format === "json"
      ? formatJsonRunReport(report)
      : formatTextRunReport(report),
  );
  return { run: analysis, report };
}

const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Policy comes from the same base commit as the base lockfile, never the
 * working tree, so a change under review cannot approve its own exception
 * (ADR-015). Working-tree changes are only reported; head YAML is never
 * parsed.
 */
async function readBaseConfig(
  commit: string,
  runtime: CliRuntime,
  configPath: string,
  isDefault: boolean,
): Promise<ReturnType<typeof emptyCapdeltaConfig>> {
  const text = await readGitBaseFile(
    commit,
    runtime.cwd,
    configPath,
    MAX_CONFIG_BYTES,
  );
  // Diagnostic only: a failed comparison must not discard valid base policy.
  let changed = false;
  try {
    changed = await pathChanged(commit, runtime.cwd, configPath);
  } catch (error: unknown) {
    if (!(error instanceof CliOperationalError)) throw error;
    runtime.stderr(
      `capdelta: could not compare ${terminalSafeText(configPath)} with base ${commit}; the base version is used: ${terminalSafeError(error)}\n`,
    );
  }
  if (changed) {
    runtime.stderr(
      `capdelta: ${terminalSafeText(configPath)} differs from base ${commit}; the base version is used\n`,
    );
  }
  if (text === null) {
    if (!isDefault || changed) {
      runtime.stderr(
        `capdelta: ${terminalSafeText(configPath)} is not present at base ${commit}; no exceptions applied\n`,
      );
    }
    return emptyCapdeltaConfig();
  }
  try {
    return parseCapdeltaConfig(text);
  } catch (error: unknown) {
    throw new CliOperationalError(`base config ${configPath} is invalid`, {
      cause: error,
    });
  }
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
  let read: ReadRegularFileResult;
  try {
    read = await readRegularFile(path, maxBytes);
  } catch (error: unknown) {
    const message =
      readRegularFileOperation(error) === "inspect"
        ? `cannot inspect head ${LOCKFILE_NAME}`
        : `cannot read head ${LOCKFILE_NAME}`;
    throw new CliOperationalError(message, {
      cause: error,
    });
  }
  if (read.kind === "not-regular") {
    throw new CliOperationalError(
      `head ${LOCKFILE_NAME} must be a regular file, not a symlink`,
    );
  }
  if (read.kind === "too-large") {
    throw new CliOperationalError(
      `head ${LOCKFILE_NAME} exceeds the ${String(maxBytes)} byte limit`,
    );
  }
  return decodeUtf8(read.bytes, `head ${LOCKFILE_NAME}`);
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
