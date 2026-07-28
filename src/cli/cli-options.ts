import { CliUsageError } from "./cli-errors.js";

/** BSD sysexits EX_USAGE; PLAN §4.5 reserves exit 2 for future --strict. */
export const USAGE_ERROR_EXIT_CODE = 64;

export const CLI_HELP = [
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

export interface CliArguments {
  help: boolean;
  base: string | null;
  format: "text" | "json";
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
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
