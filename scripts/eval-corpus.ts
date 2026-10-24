import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import { isRecord } from "../src/core/guards.js";
import { NamedError } from "../src/core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../src/core/report-builder.js";
import type { SeverityCounts } from "../src/core/report-contract.js";
import { SEVERITIES } from "../src/core/run-severity.js";
import {
  parseCorpus,
  renderReport,
  type EntryResult,
  type MaxSeverity,
} from "./eval-metrics.js";
import { analyzeOnce, MAX_ATTEMPTS, type Attempt } from "./m5-measure.js";

export interface RunIdentity {
  commit: string;
  startedAt: string;
  finishedAt: string;
  node: string;
}

export interface CorpusRunResult {
  id: string;
  result: EntryResult;
  attempts: Attempt[];
}

export interface CorpusResultsFile {
  schemaVersion: 1;
  identity: RunIdentity;
  corpus: string;
  results: CorpusRunResult[];
}

export class EvalRunError extends NamedError {}

export function entryResultFromAttempt(
  id: string,
  attempts: readonly Attempt[],
): EntryResult {
  const attempt = attempts.at(-1);
  if (attempt === undefined)
    throw new EvalRunError(
      `no analysis attempt for ${JSON.stringify(truncate(id, MAX_IDENTITY_CHARS))}`,
    );
  const analyzed = attempt.status === "analyzed";
  return {
    id,
    analyzed,
    gateCritical: attempt.gateFail,
    maxSeverity: analyzed
      ? highestSeverity(attempt.report.summary.bySeverity)
      : "NONE",
    incomplete: attempt.strictIncomplete,
  };
}

function highestSeverity(counts: SeverityCounts): MaxSeverity {
  for (const severity of SEVERITIES) if (counts[severity] > 0) return severity;
  return "NONE";
}

export async function runCorpus(
  corpusPath: string,
  out: string,
  analyze: (pair: ChangedPackage) => Promise<Attempt> = analyzeOnce,
): Promise<void> {
  const corpus = parseCorpus(await readJson(corpusPath));
  const startedAt = new Date().toISOString();
  const results: CorpusRunResult[] = [];
  for (const entry of corpus.entries) {
    if (entry.provenance !== "real-registry") continue;
    const pair = entry.pair;
    if (pair === undefined)
      throw new EvalRunError(
        `${JSON.stringify(truncate(entry.id, MAX_IDENTITY_CHARS))}: real-registry entry has no pair`,
      );
    const attempts: Attempt[] = [];
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      const attempt = await analyze(pair);
      attempts.push(attempt);
      if (!(attempt.status === "unavailable" && attempt.transient)) break;
    }
    results.push({
      id: entry.id,
      result: entryResultFromAttempt(entry.id, attempts),
      attempts,
    });
    process.stderr.write(
      `${JSON.stringify(truncate(entry.id, MAX_IDENTITY_CHARS))}: ${attempts.map((attempt) => attempt.status).join(",")}\n`,
    );
  }
  const payload: CorpusResultsFile = {
    schemaVersion: 1,
    identity: {
      commit: gitHead(),
      startedAt,
      finishedAt: new Date().toISOString(),
      node: process.version,
    },
    corpus: corpusPath,
    results,
  };
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function reportCorpus(
  corpusPath: string,
  resultsPath: string,
  out: string,
): Promise<void> {
  const corpus = parseCorpus(await readJson(corpusPath));
  const results = parseResultsFile(await readJson(resultsPath));
  const markdown = renderReport(corpus, results, {
    generatedAt: new Date().toISOString(),
    commit: gitHead(),
  });
  await writeFile(out, markdown, "utf8");
}

function parseResultsFile(value: unknown): EntryResult[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.results)
  )
    throw new EvalRunError(
      "results file: expected schemaVersion 1 and a results array",
    );
  return value.results.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.result))
      throw new EvalRunError(
        `results[${String(index)}]: expected a result object`,
      );
    return parseEntryResult(item.result, index);
  });
}

function parseEntryResult(
  raw: Record<string, unknown>,
  index: number,
): EntryResult {
  const where = `results[${String(index)}].result`;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0)
    throw new EvalRunError(`${where}.id: expected a non-empty string`);
  const analyzed = raw.analyzed;
  const gateCritical = raw.gateCritical;
  const incomplete = raw.incomplete;
  if (
    typeof analyzed !== "boolean" ||
    typeof gateCritical !== "boolean" ||
    typeof incomplete !== "boolean"
  )
    throw new EvalRunError(
      `${where}: analyzed, gateCritical and incomplete must be booleans`,
    );
  const maxSeverity = raw.maxSeverity;
  if (
    maxSeverity !== "NONE" &&
    maxSeverity !== "LOW" &&
    maxSeverity !== "MEDIUM" &&
    maxSeverity !== "HIGH" &&
    maxSeverity !== "CRITICAL"
  )
    throw new EvalRunError(
      `${where}.maxSeverity: expected NONE, LOW, MEDIUM, HIGH or CRITICAL`,
    );
  return { id, analyzed, gateCritical, maxSeverity, incomplete };
}

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EvalRunError(`cannot read JSON from ${path}: ${reason}`, {
      cause: error,
    });
  }
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (error: unknown) {
    throw new EvalRunError("cannot read the git commit", { cause: error });
  }
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${truncate(message.replace(/\s+/gu, " "), MAX_VALUE_CHARS)}`;
}

const USAGE =
  "Usage: tsx scripts/eval-corpus.ts run <corpus.json> <results.json>\n" +
  "       tsx scripts/eval-corpus.ts report <corpus.json> <results.json> <out.md>\n";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "run" && rest.length === 2) {
    const [corpusPath, out] = rest;
    if (corpusPath !== undefined && out !== undefined) {
      await runCorpus(corpusPath, out);
      return;
    }
  }
  if (command === "report" && rest.length === 3) {
    const [corpusPath, resultsPath, out] = rest;
    if (
      corpusPath !== undefined &&
      resultsPath !== undefined &&
      out !== undefined
    ) {
      await reportCorpus(corpusPath, resultsPath, out);
      return;
    }
  }
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
