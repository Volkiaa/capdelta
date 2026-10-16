import { describe, expect, it } from "vitest";
import { CliUsageError } from "./cli-errors.js";
import { CLI_HELP, parseCliArguments } from "./cli-options.js";

describe("CLI options", () => {
  it("parses the base and optional report format", () => {
    expect(parseCliArguments(["--base", "main"])).toEqual({
      help: false,
      base: "main",
      format: "text",
      configPath: null,
      failOn: "CRITICAL",
      strict: false,
    });
    expect(
      parseCliArguments(["--format", "json", "--base", "origin/main"]),
    ).toEqual({
      help: false,
      base: "origin/main",
      format: "json",
      configPath: null,
      failOn: "CRITICAL",
      strict: false,
    });
  });

  it("parses a case-insensitive --fail-on threshold", () => {
    expect(
      parseCliArguments(["--base", "main", "--fail-on", "high"]),
    ).toMatchObject({ failOn: "HIGH" });
    expect(
      parseCliArguments(["--fail-on", "none", "--base", "main"]),
    ).toMatchObject({ failOn: "none" });
  });

  it("accepts help without inventing a base revision", () => {
    expect(parseCliArguments(["--help"])).toEqual({
      help: true,
      base: null,
      format: "text",
      configPath: null,
      failOn: "CRITICAL",
      strict: false,
    });
    expect(CLI_HELP).toContain("Usage: capdelta --base <ref>");
  });

  it.each([
    { argv: ["--base"], message: "--base requires a Git revision" },
    { argv: ["--base", ""], message: "--base requires a Git revision" },
    {
      argv: ["--base", "main", "--base", "HEAD"],
      message: "--base may only be provided once",
    },
    { argv: ["--format"], message: "--format must be text or json" },
    { argv: ["--config"], message: "--config requires a path" },
    { argv: ["--config", ""], message: "--config requires a path" },
    {
      argv: ["--strict", "--strict"],
      message: "--strict may only be provided once",
    },
    {
      argv: ["--format", "text", "--format", "json"],
      message: "--format may only be provided once",
    },
    { argv: ["--unknown"], message: 'unknown argument "--unknown"' },
    { argv: ["--fail-on"], message: "--fail-on requires a severity or none" },
    {
      argv: ["--fail-on", "--strict"],
      message: "--fail-on requires a severity or none",
    },
    {
      argv: ["--fail-on", "urgent"],
      message: "--fail-on must be CRITICAL, HIGH, MEDIUM, LOW, INFO, or none",
    },
    {
      argv: ["--fail-on", "HIGH", "--fail-on", "LOW"],
      message: "--fail-on may only be provided once",
    },
  ])("rejects invalid usage: $message", ({ argv, message }) => {
    expect(() => parseCliArguments(argv)).toThrow(new CliUsageError(message));
  });
});
