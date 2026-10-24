import {
  parseFailOn,
  SeverityGateConfigurationError,
  type FailOn,
} from "../core/run-severity.js";
import { CliUsageError } from "./cli-errors.js";

/**
 * BSD sysexits EX_USAGE; strict incomplete-analysis failures use exit 2.
 * Severity-gate failures and operational errors share exit 1; stderr names
 * the cause.
 */
export const USAGE_ERROR_EXIT_CODE = 64;
export const STRICT_ANALYSIS_EXIT_CODE = 2;
// PLAN §4.5
export const DEFAULT_FAIL_ON: FailOn = "CRITICAL";

export const CLI_HELP = [
  "Usage: capdelta --base <ref> [--format text|json] [--config path] [--fail-on severity] [--strict] [--intel-url url]",
  "",
  "Compare the checkout's package-lock.json with a Git base revision.",
  "",
  "Options:",
  "  --base <ref>          Git revision used as the baseline (required)",
  "  --format text|json    Report format (default: text)",
  "  --config <path>       Allowlist config, read from the base commit",
  "                        (relative to cwd; default: .capdelta.yml)",
  "  --intel-url <url>     Query a shared intelligence feed for artifacts",
  "                        reviewers confirmed malicious (https, or http on",
  "                        localhost, 127.0.0.1, [::1])",
  "  --fail-on <severity>  Exit 1 at or above CRITICAL, HIGH, MEDIUM, LOW, INFO,",
  "                        or never with none (default: CRITICAL)",
  "  --strict              Exit 2 when any content is unanalyzed; takes",
  "                        precedence over --fail-on",
  "  --help                Show this help",
  "",
].join("\n");

export interface CliArguments {
  help: boolean;
  base: string | null;
  format: "text" | "json";
  configPath: string | null;
  failOn: FailOn;
  strict: boolean;
  intelUrl: string | null;
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  let help = false;
  let base: string | null = null;
  let format: "text" | "json" = "text";
  let formatSeen = false;
  let configPath: string | null = null;
  let failOn: FailOn | null = null;
  let strict = false;
  let intelUrl: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--base") {
      if (base !== null)
        throw new CliUsageError("--base may only be provided once");
      base = readFlagValue(argv, index, "--base", "a Git revision");
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
    if (argument === "--config") {
      if (configPath !== null) {
        throw new CliUsageError("--config may only be provided once");
      }
      configPath = readFlagValue(argv, index, "--config", "a path");
      index += 1;
      continue;
    }
    if (argument === "--fail-on") {
      if (failOn !== null) {
        throw new CliUsageError("--fail-on may only be provided once");
      }
      failOn = parseFailOnArgument(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--strict") {
      if (strict) throw new CliUsageError("--strict may only be provided once");
      strict = true;
      continue;
    }
    if (argument === "--intel-url") {
      if (intelUrl !== null) {
        throw new CliUsageError("--intel-url may only be provided once");
      }
      intelUrl = readFlagValue(argv, index, "--intel-url", "a URL");
      index += 1;
      continue;
    }
    throw new CliUsageError(`unknown argument ${JSON.stringify(argument)}`);
  }

  return {
    help,
    base,
    format,
    configPath,
    failOn: failOn ?? DEFAULT_FAIL_ON,
    strict,
    intelUrl,
  };
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  noun: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires ${noun}`);
  }
  return value;
}

function parseFailOnArgument(value: string | undefined): FailOn {
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError("--fail-on requires a severity or none");
  }
  try {
    return parseFailOn(value);
  } catch (error: unknown) {
    if (error instanceof SeverityGateConfigurationError) {
      throw new CliUsageError(
        "--fail-on must be CRITICAL, HIGH, MEDIUM, LOW, INFO, or none",
      );
    }
    throw error;
  }
}
