import { once } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { collectStringContent, parseSource } from "./javascript-parse.js";
import type {
  ParserRequest,
  ParserSuccess,
  ParserWorkerMessage,
} from "./javascript-parser-protocol.js";

const workerPath = resolve(
  import.meta.dirname,
  "../../../dist/core/npm/javascript-parser-worker.js",
);

/**
 * Runs the compiled worker, because importing the worker module registers a
 * parent-port listener that throws outside a worker thread.
 */
async function parseInWorker(
  sources: readonly string[],
): Promise<ParserSuccess[]> {
  if (!existsSync(workerPath)) {
    throw new Error(`${workerPath} is missing. Run npm run build first.`);
  }
  const worker = new Worker(pathToFileURL(workerPath));
  try {
    const [ready] = (await once(worker, "message")) as [ParserWorkerMessage];
    if ("type" in ready) {
      const results: ParserSuccess[] = [];
      for (const source of sources) {
        const request: ParserRequest = {
          source,
          file: "a.js",
          language: "javascript",
          sourceType: "either",
        };
        worker.postMessage(request);
        const [message] = (await once(worker, "message")) as [
          ParserWorkerMessage,
        ];
        if ("type" in message) throw new Error("worker sent a second ready");
        if (!message.ok) {
          throw new Error(`worker rejected the source: ${message.detail}`);
        }
        results.push(message);
      }
      return results;
    }
    throw new Error("worker did not start with a ready message");
  } finally {
    await worker.terminate();
  }
}

describe("parser worker string content", () => {
  const sources = [
    "const u = `https://evil.test/${x}\\n`;",
    'const u = "https://evil\\x2etest/x"; f("a\\tb");',
    "#!/usr/bin/env node\n// https://docs.test/a\nconst x = 'a'; /* b */\n",
    "f(\"https://a.test/\", `b`, 'c\\u002fd');",
  ];

  it("matches collectStringContent and parseSource on every source", async () => {
    const results = await parseInWorker(sources);
    for (const [index, source] of sources.entries()) {
      const { ast, comments } = parseSource(source, "either");
      const expected = collectStringContent(ast, source);
      const actual = results[index];
      expect(actual, source).toBeDefined();
      expect(actual?.comments, source).toEqual(comments);
      expect(actual?.stringRanges, source).toEqual(expected.stringRanges);
      expect(actual?.cookedStrings, source).toEqual(expected.cookedStrings);
    }
  });

  it("keeps every string range in a source with 500000 strings", async () => {
    const source = `f(${Array.from({ length: 500_000 }, () => '""').join(",")});`;
    const [result] = await parseInWorker([source]);
    expect(result).toBeDefined();
    expect(result?.stringRanges).toHaveLength(500_000);
    expect(result?.cookedStrings).toEqual([]);
  }, 20_000);
});
