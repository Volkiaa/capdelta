import { describe, expect, it } from "vitest";
import {
  collectStringContent,
  parseSource,
} from "../src/core/npm/javascript-parse.js";
import * as signals from "../src/core/signal-extractor.js";
import { fuzz, parseArguments, type SignalModule } from "./difffuzz.js";

const options = { seed: 1, iterations: 2_000, narrow: false };

describe("difffuzz", () => {
  it("finds no difference between an extractor and itself", () => {
    expect(fuzz(signals, signals, options)).toEqual({
      differences: 0,
      examples: [],
    });
  });

  it("finds an extractor that drops the last endpoint", () => {
    const dropsLast: SignalModule = {
      observeSignalSource: signals.observeSignalSource,
      buildSignalSet: (observations) => {
        const set = signals.buildSignalSet(observations);
        return { ...set, endpoints: set.endpoints.slice(0, -1) };
      },
    };
    const result = fuzz(signals, dropsLast, options);
    expect(result.differences).toBeGreaterThan(0);
    expect(result.examples.length).toBeGreaterThan(0);
  });

  it("feeds cooked string values to the extractor", () => {
    const ignoresCooked: SignalModule = {
      observeSignalSource: (input) =>
        signals.observeSignalSource({
          file: input.file,
          bytes: input.bytes,
          parseState: input.parseState,
          ...(input.commentRanges === undefined
            ? {}
            : { commentRanges: input.commentRanges }),
          ...(input.stringRanges === undefined
            ? {}
            : { stringRanges: input.stringRanges }),
        }),
      buildSignalSet: signals.buildSignalSet,
    };
    const result = fuzz(signals, ignoresCooked, { ...options, seed: 9 });
    expect(result.differences).toBeGreaterThan(0);
  });

  it("reports a string range without its quotes", () => {
    const text = 'f("https://a.test/");';
    const { ast } = parseSource(text, "either");
    const { stringRanges } = collectStringContent(ast, text);
    expect(stringRanges.map(([start, end]) => text.slice(start, end))).toEqual([
      "https://a.test/",
    ]);
  });
});

describe("difffuzz arguments", () => {
  it("defaults to origin/main and accepts bounded options", () => {
    expect(parseArguments([])).toEqual({
      base: "origin/main",
      seed: 1,
      iterations: 500_000,
      narrow: false,
    });
    expect(
      parseArguments([
        "--base",
        "v0.1.0",
        "--seed",
        "7",
        "--iterations",
        "10",
        "--narrow",
      ]),
    ).toEqual({ base: "v0.1.0", seed: 7, iterations: 10, narrow: true });
  });

  it.each([
    [["--base", "--output=x"]],
    [["--seed", "0"]],
    [["--iterations", "1.5"]],
    [["--iterations"]],
    [["--unknown", "x"]],
  ])("rejects %j", (argv) => {
    expect(() => parseArguments(argv)).toThrow();
  });
});
