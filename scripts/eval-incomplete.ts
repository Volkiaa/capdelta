import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { compareText } from "../src/core/compare.js";
import { isRecord } from "../src/core/guards.js";
import { NamedError } from "../src/core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../src/core/report-builder.js";
import type {
  JsonReportDiagnostic,
  JsonRunReport,
  ReportPackage,
} from "../src/core/report-contract.js";

/** The bounded report of one release, which is all a cause needs. */
export interface IncompleteAnalysis {
  id: string;
  report: JsonRunReport;
}

export interface IncompleteCauseRow {
  cause: string;
  count: number;
  share: number;
  example: string;
}

export class EvalIncompleteError extends NamedError {}

const PATH_PATTERN = /\S*[\\/]\S*/gu;
const FILE_PATTERN = /\b[\w@.-]+\.(?:[cm]?[jt]sx?|json|node|map)\b/gu;
const NUMBER_PATTERN = /\b\d+(?:\.\d+)*\b/gu;

/**
 * Reduce a message to a stable class so packages that report the same problem
 * share a row. Values that vary per release, such as file paths, versions and
 * line numbers, are replaced.
 */
export function messageClass(detail: string): string {
  const classified = detail
    .replace(PATH_PATTERN, "<path>")
    .replace(FILE_PATTERN, "<path>")
    .replace(NUMBER_PATTERN, "#")
    .replace(/\s+/gu, " ")
    .trim();
  return truncate(classified, MAX_VALUE_CHARS);
}

export function groupIncompleteCauses(
  incomplete: readonly IncompleteAnalysis[],
): IncompleteCauseRow[] {
  if (incomplete.length === 0) return [];
  const groups = new Map<string, { count: number; example: string }>();
  for (const item of incomplete) {
    const found = primaryCause(item);
    const group = groups.get(found.cause);
    if (group === undefined) {
      groups.set(found.cause, { count: 1, example: found.example });
    } else {
      group.count += 1;
    }
  }
  return [...groups]
    .map(([cause, group]) => ({
      cause,
      count: group.count,
      share: group.count / incomplete.length,
      example: group.example,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || compareText(left.cause, right.cause),
    );
}

interface FoundCause {
  cause: string;
  example: string;
}

function primaryCause(item: IncompleteAnalysis): FoundCause {
  for (const itemPackage of item.report.packages) {
    if (itemPackage.status === "unavailable") {
      const failure = itemPackage.failures[0];
      return found(
        `unavailable ${failure.stage}/${failure.kind}`,
        failure.detail,
        itemPackage.package,
      );
    }
    const issue = itemPackage.issues[0];
    if (issue !== undefined) {
      return found(
        `${issue.stage}/${issue.kind}`,
        issue.detail,
        itemPackage.report.package,
      );
    }
    const baseline = itemPackage.baselineFailures[0];
    if (baseline !== undefined) {
      return found(
        `baseline ${baseline.stage}/${baseline.kind}`,
        baseline.detail,
        itemPackage.report.package,
      );
    }
    const diagnostic = dominantDiagnostic(itemPackage.report.diagnostics);
    if (diagnostic !== null) {
      return found(
        diagnostic.kind,
        diagnostic.detail,
        itemPackage.report.package,
      );
    }
  }
  const skipped = item.report.skipped[0];
  if (skipped !== undefined) {
    return {
      cause: `skipped ${skipped.reason}: ${messageClass(skipped.detail)}`,
      example: truncate(item.id, MAX_IDENTITY_CHARS),
    };
  }
  if (item.report.budget?.partial === true) {
    return {
      cause: "analysis budget exhausted",
      example: truncate(item.id, MAX_IDENTITY_CHARS),
    };
  }
  return {
    cause: "unattributed",
    example: truncate(item.id, MAX_IDENTITY_CHARS),
  };
}

function dominantDiagnostic(
  diagnostics: readonly JsonReportDiagnostic[],
): JsonReportDiagnostic | null {
  const classes = new Map<
    string,
    { count: number; first: JsonReportDiagnostic }
  >();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.kind}: ${messageClass(diagnostic.detail)}`;
    const entry = classes.get(key);
    if (entry === undefined) classes.set(key, { count: 1, first: diagnostic });
    else entry.count += 1;
  }
  let best: JsonReportDiagnostic | null = null;
  let bestCount = 0;
  for (const entry of classes.values()) {
    if (entry.count > bestCount) {
      best = entry.first;
      bestCount = entry.count;
    }
  }
  return best;
}

function found(
  label: string,
  detail: string,
  itemPackage: ReportPackage,
): FoundCause {
  return {
    cause: `${label}: ${messageClass(detail)}`,
    example: exampleOf(itemPackage),
  };
}

function exampleOf(itemPackage: ReportPackage): string {
  if (itemPackage.oldVersion === null)
    return truncate(
      `${itemPackage.name}@${itemPackage.newVersion} (new package)`,
      MAX_IDENTITY_CHARS,
    );
  return truncate(
    `${itemPackage.name}@${itemPackage.oldVersion}->${itemPackage.newVersion}`,
    MAX_IDENTITY_CHARS,
  );
}

export function renderIncompleteCauses(
  rows: readonly IncompleteCauseRow[],
  total: number,
): string {
  const incomplete = rows.reduce((sum, row) => sum + row.count, 0);
  const lines = [
    "# Incomplete analysis causes",
    "",
    `${String(incomplete)} of ${String(total)} real-registry results are incomplete. Each release is counted once, under the first cause reported: an analysis issue, a baseline failure, or the most frequent diagnostic class.`,
    "",
    "| Cause | Count | Share of incomplete | Example |",
    "| --- | ---: | ---: | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.cause)} | ${String(row.count)} | ${(row.share * 100).toFixed(1)}% | ${escapeCell(row.example)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\|/gu, "\\|")
    .replace(/\r?\n/gu, " ");
}

interface ParsedResults {
  total: number;
  incomplete: IncompleteAnalysis[];
}

function parseResultsFile(value: unknown): ParsedResults {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.results)
  )
    throw new EvalIncompleteError(
      "results file: expected schemaVersion 1 and a results array",
    );
  const incomplete: IncompleteAnalysis[] = [];
  value.results.forEach((item, index) => {
    const where = `results[${String(index)}]`;
    if (!isRecord(item) || !isRecord(item.result))
      throw new EvalIncompleteError(`${where}: expected a result object`);
    if (item.result.incomplete !== true) return;
    const id = item.result.id;
    if (typeof id !== "string" || id.length === 0)
      throw new EvalIncompleteError(`${where}.result.id: expected a string`);
    if (!Array.isArray(item.attempts) || item.attempts.length === 0)
      throw new EvalIncompleteError(
        `${where}: incomplete result has no analysis attempt`,
      );
    const attempts: readonly unknown[] = item.attempts;
    const attempt = attempts.at(-1);
    if (!isRecord(attempt) || !isRecord(attempt.report))
      throw new EvalIncompleteError(
        `${where}: last attempt has no report object`,
      );
    if (!Array.isArray(attempt.report.packages))
      throw new EvalIncompleteError(
        `${where}: last attempt report has no packages array`,
      );
    incomplete.push({
      id,
      report: attempt.report as unknown as JsonRunReport,
    });
  });
  return { total: value.results.length, incomplete };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EvalIncompleteError(`cannot read JSON from ${path}: ${reason}`, {
      cause: error,
    });
  }
}

const USAGE = "Usage: tsx scripts/eval-incomplete.ts <results.json>\n";

async function main(): Promise<void> {
  const [resultsPath, ...rest] = process.argv.slice(2);
  if (resultsPath === undefined || rest.length > 0) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const parsed = parseResultsFile(await readJson(resultsPath));
  process.stdout.write(
    renderIncompleteCauses(
      groupIncompleteCauses(parsed.incomplete),
      parsed.total,
    ),
  );
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${truncate(message.replace(/\s+/gu, " "), MAX_VALUE_CHARS)}`;
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
