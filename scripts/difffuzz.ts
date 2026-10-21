import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { valueHasWords } from "../src/core/npm/url-value-words.js";
import * as headModule from "../src/core/signal-extractor.js";

export type SignalModule = Pick<
  typeof headModule,
  "observeSignalSource" | "buildSignalSet"
>;

export interface FuzzOptions {
  seed: number;
  iterations: number;
  narrow: boolean;
}

export interface FuzzDifference {
  text: string;
  parsed: boolean;
  base: string;
  head: string;
}

export interface FuzzResult {
  differences: number;
  examples: FuzzDifference[];
}

export interface FuzzArguments extends FuzzOptions {
  base: string;
}

const MAX_EXAMPLES = 8;

const WIDE_PARTS = [
  "https://",
  "http://",
  "wss://",
  "evil.test",
  "a.test",
  "x",
  "/",
  "?",
  "#",
  "@",
  ":",
  "443",
  "${x}",
  " ",
  "\t",
  "\n",
  "\r",
  "\\",
  "\\x20",
  '"',
  "'",
  "`",
  "<",
  ">",
  ")",
  ".",
  ",",
  "]",
  "[",
  "::1",
  "%",
  "\u0000",
  "\u0001",
  "//",
  "///",
  "%2e",
  "é",
  "xn--e1a",
  "a",
];

const NARROW_PARTS = [
  "https://",
  "evil.test",
  "a.test",
  "/",
  "?",
  "#",
  "@",
  "${x}",
  " ",
  "\\x20",
  "\u0000",
  "\u0001",
  "x",
  ":",
  ")",
  "//",
];

const QUOTES = ["`", '"', "'"];

/**
 * Feeds the same generated string literals to two signal extractors and
 * counts the inputs whose endpoint output differs.
 */
export function fuzz(
  base: SignalModule,
  head: SignalModule,
  options: FuzzOptions,
): FuzzResult {
  const parts = options.narrow ? NARROW_PARTS : WIDE_PARTS;
  const maxParts = options.narrow ? 6 : 8;
  const random = mulberry32(options.seed);
  const examples: FuzzDifference[] = [];
  let differences = 0;
  for (let i = 0; i < options.iterations; i++) {
    let body = "";
    const count = 1 + random(maxParts);
    for (let j = 0; j < count; j++) body += pick(parts, random);
    const quote = pick(QUOTES, random);
    const text = `f(${quote}${body}${quote});`;
    const parsed = random(2) === 0;
    const baseOutput = endpoints(base, text, parsed, body);
    const headOutput = endpoints(head, text, parsed, body);
    if (baseOutput === headOutput) continue;
    differences++;
    if (examples.length < MAX_EXAMPLES) {
      examples.push({ text, parsed, base: baseOutput, head: headOutput });
    }
  }
  return { differences, examples };
}

function endpoints(
  module: SignalModule,
  text: string,
  parsed: boolean,
  body: string,
): string {
  const input = {
    file: "a.js",
    bytes: new TextEncoder().encode(text),
    ...(parsed
      ? {
          parseState: "parsed" as const,
          stringRanges: [[3, text.length - 2, valueHasWords(body)] as const],
        }
      : { parseState: "unparseable" as const }),
  };
  try {
    const set = module.buildSignalSet([module.observeSignalSource(input)]);
    return JSON.stringify(
      set.endpoints.map((endpoint) => [
        endpoint.endpointType,
        endpoint.normalizedValue,
        endpoint.context,
        endpoint.confidence,
        endpoint.evidence,
      ]),
    );
  } catch (error) {
    return `THROW ${error instanceof Error ? error.message : typeof error}`;
  }
}

function pick(
  values: readonly string[],
  random: (bound: number) => number,
): string {
  const value = values[random(values.length)];
  if (value === undefined) throw new Error("random index out of range");
  return value;
}

function mulberry32(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % bound;
  };
}

export function parseArguments(argv: readonly string[]): FuzzArguments {
  const parsed: FuzzArguments = {
    base: "origin/main",
    seed: 1,
    iterations: 500_000,
    narrow: false,
  };
  const rest = [...argv];
  for (let flag = rest.shift(); flag !== undefined; flag = rest.shift()) {
    if (flag === "--narrow") {
      parsed.narrow = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--base") {
      // A ref starting with "-" would reach git as an option.
      if (value.startsWith("-")) throw new Error(`invalid ref: ${value}`);
      parsed.base = value;
    } else if (flag === "--seed") {
      parsed.seed = positiveInteger(flag, value);
    } else if (flag === "--iterations") {
      parsed.iterations = positiveInteger(flag, value);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return parsed;
}

function positiveInteger(flag: string, value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${flag} must be a positive integer, got ${value}`);
  }
  return number;
}

async function loadBase(ref: string, directory: string): Promise<SignalModule> {
  const archive = join(directory, "src.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", archive, ref, "src"]);
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  return (await import(
    pathToFileURL(join(directory, "src/core/signal-extractor.ts")).href
  )) as SignalModule;
}

async function main(): Promise<void> {
  let options: FuzzArguments;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(
      "usage: npm run difffuzz -- [--base <ref>] [--seed <n>] [--iterations <n>] [--narrow]",
    );
    process.exitCode = 2;
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "capdelta-difffuzz-"));
  try {
    const base = await loadBase(options.base, directory);
    const result = fuzz(base, headModule, options);
    for (const example of result.examples) {
      console.log(
        JSON.stringify(example.text),
        example.parsed ? "parsed" : "unparseable",
      );
      console.log(`  ${options.base}: ${example.base.slice(0, 200)}`);
      console.log(`  working tree: ${example.head.slice(0, 200)}`);
    }
    console.log(
      `differences: ${String(result.differences)} of ${String(options.iterations)}`,
    );
    if (result.differences > 0) process.exitCode = 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
