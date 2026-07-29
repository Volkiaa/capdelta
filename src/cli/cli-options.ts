import { CliUsageError } from "./cli-errors.js";

/** BSD sysexits EX_USAGE; strict incomplete-analysis failures use exit 2. */
export const USAGE_ERROR_EXIT_CODE = 64;
export const STRICT_ANALYSIS_EXIT_CODE = 2;

export const CLI_HELP = [
  "Usage: capdelta --base <ref> [--format text|json] [--config path] [--strict]",
  "",
  "Compare the checkout's package-lock.json with a Git base revision.",
  "",
  "Options:",
  "  --base <ref>          Git revision used as the baseline (required)",
  "  --format text|json    Report format (default: text)",
  "  --config <path>       Allowlist config (default: .capdelta.yml)",
  "  --strict              Exit 2 when any content is unanalyzed",
  "  --help                Show this help",
  "",
].join("\n");

export interface CliArguments {
  help: boolean;
  base: string | null;
  format: "text" | "json";
  configPath: string | null;
  strict: boolean;
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  let help = false;
  let base: string | null = null;
  let format: "text" | "json" = "text";
  let formatSeen = false;
  let configPath: string | null = null;
  let strict = false;

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
    if (argument === "--config") {
      if (configPath !== null) {
        throw new CliUsageError("--config may only be provided once");
      }
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new CliUsageError("--config requires a path");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument === "--strict") {
      if (strict) throw new CliUsageError("--strict may only be provided once");
      strict = true;
      continue;
    }
    throw new CliUsageError(`unknown argument ${JSON.stringify(argument)}`);
  }

  return { help, base, format, configPath, strict };
}
