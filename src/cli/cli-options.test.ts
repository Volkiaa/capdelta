import { describe, expect, it } from "vitest";
import { CliUsageError } from "./cli-errors.js";
import { CLI_HELP, parseCliArguments } from "./cli-options.js";

describe("CLI options", () => {
  it("parses the base and optional report format", () => {
    expect(parseCliArguments(["--base", "main"])).toEqual({
      help: false,
      base: "main",
      format: "text",
    });
    expect(
      parseCliArguments(["--format", "json", "--base", "origin/main"]),
    ).toEqual({ help: false, base: "origin/main", format: "json" });
  });

  it("accepts help without inventing a base revision", () => {
    expect(parseCliArguments(["--help"])).toEqual({
      help: true,
      base: null,
      format: "text",
    });
    expect(CLI_HELP).toContain("Usage: capdelta --base <ref>");
  });

  it.each([
    { argv: ["--base"], message: "--base requires a Git revision" },
    {
      argv: ["--base", "main", "--base", "HEAD"],
      message: "--base may only be provided once",
    },
    { argv: ["--format"], message: "--format must be text or json" },
    {
      argv: ["--format", "text", "--format", "json"],
      message: "--format may only be provided once",
    },
    { argv: ["--unknown"], message: 'unknown argument "--unknown"' },
  ])("rejects invalid usage: $message", ({ argv, message }) => {
    expect(() => parseCliArguments(argv)).toThrow(new CliUsageError(message));
  });
});
