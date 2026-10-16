// PLAN §7.4
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
} from "../src/core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import { buildRunReport } from "../src/core/report-builder.js";
import type { JsonRunReport } from "../src/core/report-contract.js";
import { evaluateSeverityGate } from "../src/core/run-severity.js";
import { changedPackage, recentVersions } from "./fp-check.js";

const BUMPS_PER_PACKAGE = 3;
const MAX_ATTEMPTS = 3;
const TRANSIENT_FETCH_KINDS = new Set(["network-error", "timeout"]);

export interface FrozenCorpus {
  schemaVersion: 1;
  selectedAt: string;
  rule: string;
  packages: readonly string[];
  pairs: readonly ChangedPackage[];
  selectionFailures: readonly { package: string; error: string }[];
}

export interface Attempt {
  startedAt: string;
  status: "analyzed" | "unavailable";
  transient: boolean;
  gateFail: boolean;
  strictIncomplete: boolean;
  report: JsonRunReport;
}

export function isTransient(report: JsonRunReport): boolean {
  const failures = report.packages.flatMap((item) =>
    item.status === "unavailable" ? item.failures : [],
  );
  return (
    failures.length > 0 &&
    failures.every(
      (failure) =>
        failure.stage === "fetch" && TRANSIENT_FETCH_KINDS.has(failure.kind),
    )
  );
}

async function select(out: string, packages: readonly string[]): Promise<void> {
  const pairs: ChangedPackage[] = [];
  const selectionFailures: { package: string; error: string }[] = [];
  for (const name of packages) {
    try {
      const versions = await recentVersions(name, BUMPS_PER_PACKAGE + 1);
      if (versions.length < BUMPS_PER_PACKAGE + 1) {
        selectionFailures.push({
          package: name,
          error: `only ${String(versions.length)} eligible releases`,
        });
      }
      for (let index = 1; index < versions.length; index += 1) {
        const previous = versions[index - 1];
        const newest = versions[index];
        if (previous === undefined || newest === undefined) {
          throw new Error("version-pair construction failed");
        }
        pairs.push(changedPackage(name, previous, newest));
      }
    } catch (error: unknown) {
      selectionFailures.push({ package: name, error: describe(error) });
    }
  }
  const corpus: FrozenCorpus = {
    schemaVersion: 1,
    selectedAt: new Date().toISOString(),
    rule: "adjacent pairs among the 4 highest eligible versions (x.y.z only, not deprecated, sha512 integrity), ordered by version number, not publish time",
    packages,
    pairs,
    selectionFailures,
  };
  await writeFile(out, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
}

async function analyzeOnce(pair: ChangedPackage): Promise<Attempt> {
  const startedAt = new Date().toISOString();
  const run = await analyzeChangedPackages({
    changed: [pair],
    findings: [],
    skipped: [],
    firstRun: false,
  });
  const report = buildRunReport(run);
  return {
    startedAt,
    status:
      report.summary.unavailablePackages === 0 ? "analyzed" : "unavailable",
    transient: isTransient(report),
    // ADR-019
    gateFail: evaluateSeverityGate(report, "CRITICAL").fail,
    strictIncomplete: hasUnanalyzedContent(run),
    report,
  };
}

async function run(corpusPath: string, out: string): Promise<void> {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as FrozenCorpus;
  const startedAt = new Date().toISOString();
  const results: { pair: ChangedPackage; attempts: Attempt[] }[] = [];
  for (const pair of corpus.pairs) {
    const attempts: Attempt[] = [];
    for (let index = 0; index < MAX_ATTEMPTS; index += 1) {
      const attempt = await analyzeOnce(pair);
      attempts.push(attempt);
      if (!(attempt.status === "unavailable" && attempt.transient)) break;
    }
    results.push({ pair, attempts });
    process.stderr.write(
      `${pair.name} ${String(pair.oldVersion)} -> ${pair.newVersion}: ${attempts.map((a) => a.status).join(",")}\n`,
    );
  }
  const identity = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    command: process.argv.slice(1).join(" "),
    startedAt,
    finishedAt: new Date().toISOString(),
    policy: { threshold: "CRITICAL", strict: false, allowlist: "none" },
  };
  await writeFile(
    out,
    `${JSON.stringify({ schemaVersion: 1, identity, corpus: corpusPath, results }, null, 2)}\n`,
    "utf8",
  );
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, first, ...rest] = process.argv.slice(2);
  if (command === "select" && first !== undefined && rest.length > 0) {
    await select(first, rest);
  } else if (
    command === "run" &&
    first !== undefined &&
    rest[0] !== undefined
  ) {
    await run(first, rest[0]);
  } else {
    process.stderr.write(
      "Usage: tsx scripts/m5-measure.ts select <corpus.json> <package...>\n       tsx scripts/m5-measure.ts run <corpus.json> <results.json>\n",
    );
    process.exitCode = 64;
  }
}
