import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectStringContent,
  parseSource,
} from "../src/core/npm/javascript-parse.js";
import type {
  CommentRange,
  StringRange,
} from "../src/core/npm/javascript-parser-protocol.js";
import * as headModule from "../src/core/signal-extractor.js";
import type { SignalSourceInput } from "../src/core/signal-extractor.js";

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

export interface FuzzCounts {
  parsed: number;
  unparseableByChoice: number;
  unparseableBySyntax: number;
}

export interface DetailedFuzzResult extends FuzzResult {
  counts: FuzzCounts;
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
  const { differences, examples } = fuzzWithCounts(base, head, options);
  return { differences, examples };
}

/**
 * Like fuzz, but also reports how the samples were fed. The fuzzer marks some
 * samples unparseable by choice, and a sample that the parser rejects is
 * unparseable by syntax, as production records it.
 */
export function fuzzWithCounts(
  base: SignalModule,
  head: SignalModule,
  options: FuzzOptions,
): DetailedFuzzResult {
  const parts = options.narrow ? NARROW_PARTS : WIDE_PARTS;
  const maxParts = options.narrow ? 6 : 8;
  const random = mulberry32(options.seed);
  const examples: FuzzDifference[] = [];
  const counts: FuzzCounts = {
    parsed: 0,
    unparseableByChoice: 0,
    unparseableBySyntax: 0,
  };
  let differences = 0;
  for (let i = 0; i < options.iterations; i++) {
    let body = "";
    const count = 1 + random(maxParts);
    for (let j = 0; j < count; j++) body += pick(parts, random);
    const quote = pick(QUOTES, random);
    const text = `f(${quote}${body}${quote});`;
    const wantsParsed = random(2) === 0;
    const sample = wantsParsed ? parseSample(text) : null;
    let input: SignalSourceInput;
    if (sample !== null) {
      counts.parsed++;
      input = {
        file: "a.js",
        bytes: new TextEncoder().encode(text),
        parseState: "parsed",
        commentRanges: sample.comments,
        stringRanges: sample.stringRanges,
        cookedStrings: sample.cookedStrings,
      };
    } else {
      if (wantsParsed) counts.unparseableBySyntax++;
      else counts.unparseableByChoice++;
      input = {
        file: "a.js",
        bytes: new TextEncoder().encode(text),
        parseState: "unparseable",
      };
    }
    const baseOutput = endpoints(base, input);
    const headOutput = endpoints(head, input);
    if (baseOutput === headOutput) continue;
    differences++;
    if (examples.length < MAX_EXAMPLES) {
      examples.push({
        text,
        parsed: sample !== null,
        base: baseOutput,
        head: headOutput,
      });
    }
  }
  return { differences, examples, counts };
}

interface ParsedSample {
  comments: CommentRange[];
  stringRanges: StringRange[];
  cookedStrings: (readonly [start: number, value: string])[];
}

function parseSample(text: string): ParsedSample | null {
  try {
    const { ast, comments } = parseSource(text, "either");
    return { comments, ...collectStringContent(ast, text) };
  } catch (error) {
    // acorn reports a rejected sample by throwing. Production records that as
    // an unparseable parse state, so anything else is a bug worth surfacing.
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function endpoints(module: SignalModule, input: SignalSourceInput): string {
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
    const result = fuzzWithCounts(base, headModule, options);
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
    console.log(
      `samples: ${String(result.counts.parsed)} parsed, ${String(result.counts.unparseableByChoice)} unparseable-by-choice, ${String(result.counts.unparseableBySyntax)} unparseable-by-syntax`,
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
