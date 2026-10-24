import { createHash } from "node:crypto";
import type { FindingSeverity } from "../src/core/capability-differ.js";
import { compareText } from "../src/core/compare.js";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import { isRecord } from "../src/core/guards.js";
import { NamedError } from "../src/core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../src/core/report-builder.js";
import { SEVERITIES } from "../src/core/run-severity.js";

export type Severity = FindingSeverity;
export type MaxSeverity = "NONE" | Severity;
export type Label = "malicious" | "benign";
export type Provenance = "real-registry" | "synthetic-reconstruction";

export interface ResultOverride {
  gateSeverity: Record<Severity, number>;
  incomplete: boolean;
}

export interface EvalEntry {
  id: string;
  label: Label;
  source: string;
  provenance: Provenance;
  heldOut: boolean;
  /** Required for real-registry entries; a synthetic fixture may omit it. */
  pair?: ChangedPackage;
  /** Filled by reconstruction tests. Used only when no result is supplied. */
  resultOverride?: ResultOverride;
}

export interface EvalCorpus {
  schemaVersion: 1;
  createdAt: string;
  splitRule: string;
  entries: EvalEntry[];
}

export class EvalCorpusError extends NamedError {}
export class EvalMetricsError extends NamedError {}

export interface EntryResult {
  id: string;
  analyzed: boolean;
  gateCritical: boolean;
  maxSeverity: MaxSeverity;
  incomplete: boolean;
}

export interface Rate {
  detected: number;
  of: number;
  rate: number | null;
}

export interface FlagRate {
  flagged: number;
  of: number;
  rate: number | null;
}

export interface Metrics {
  total: number;
  analyzed: number;
  /** Incomplete or unavailable entries over total entries. */
  incompleteRate: number;
  recall: Rate;
  recallAtGate: Rate;
  falsePositive: FlagRate;
  falsePositiveAtGate: FlagRate;
  missed: string[];
  falsePositiveIds: string[];
}

export interface MetricsReport {
  all: Metrics;
  heldOut: Metrics;
  development: Metrics;
  byProvenance: Record<string, Metrics>;
}

export function parseCorpus(value: unknown): EvalCorpus {
  const root = asRecord(value, "corpus");
  if (root.schemaVersion !== 1)
    throw new EvalCorpusError("corpus.schemaVersion: expected 1");
  const createdAt = asString(root.createdAt, "corpus.createdAt");
  const splitRule = asString(root.splitRule, "corpus.splitRule");
  if (!Array.isArray(root.entries))
    throw new EvalCorpusError("corpus.entries: expected an array");
  const seen = new Set<string>();
  const entries = root.entries.map((raw, index) =>
    parseEntry(raw, index, seen),
  );
  return { schemaVersion: 1, createdAt, splitRule, entries };
}

function parseEntry(raw: unknown, index: number, seen: Set<string>): EvalEntry {
  const fallback = `entry[${String(index)}]`;
  if (!isRecord(raw))
    throw new EvalCorpusError(`${fallback}: expected an object`);
  const id = asString(raw.id, `${fallback}.id`);
  const where = `entry ${JSON.stringify(truncate(id, MAX_IDENTITY_CHARS))}`;
  if (seen.has(id)) throw new EvalCorpusError(`${where}: duplicate id`);
  seen.add(id);

  const label = raw.label;
  if (label !== "malicious" && label !== "benign")
    throw new EvalCorpusError(
      `${where}: label must be "malicious" or "benign"`,
    );
  const provenance = raw.provenance;
  if (
    provenance !== "real-registry" &&
    provenance !== "synthetic-reconstruction"
  )
    throw new EvalCorpusError(
      `${where}: provenance must be "real-registry" or "synthetic-reconstruction"`,
    );
  const source = asString(raw.source, `${where}.source`);
  const heldOut = raw.heldOut;
  if (typeof heldOut !== "boolean")
    throw new EvalCorpusError(`${where}.heldOut: expected a boolean`);

  const pair = raw.pair === undefined ? undefined : parsePair(raw.pair, where);
  if (provenance === "real-registry" && pair === undefined)
    throw new EvalCorpusError(`${where}: real-registry entry needs a pair`);
  const resultOverride =
    raw.resultOverride === undefined
      ? undefined
      : parseOverride(raw.resultOverride, where);

  return {
    id,
    label,
    source,
    provenance,
    heldOut,
    ...(pair === undefined ? {} : { pair }),
    ...(resultOverride === undefined ? {} : { resultOverride }),
  };
}

function parsePair(value: unknown, where: string): ChangedPackage {
  const pair = asRecord(value, `${where}.pair`);
  const name = asString(pair.name, `${where}.pair.name`);
  const oldVersion = asNullableString(
    pair.oldVersion,
    `${where}.pair.oldVersion`,
  );
  const newVersion = asString(pair.newVersion, `${where}.pair.newVersion`);
  const oldIntegrity = asNullableString(
    pair.oldIntegrity,
    `${where}.pair.oldIntegrity`,
  );
  const newIntegrity = asString(
    pair.newIntegrity,
    `${where}.pair.newIntegrity`,
  );
  const oldResolvedUrl = asNullableString(
    pair.oldResolvedUrl,
    `${where}.pair.oldResolvedUrl`,
  );
  const resolvedUrl = asString(pair.resolvedUrl, `${where}.pair.resolvedUrl`);
  const oldSide = [oldVersion, oldIntegrity, oldResolvedUrl];
  const anyOld = oldSide.some((item) => item !== null);
  const allOld = oldSide.every((item) => item !== null);
  if (anyOld && !allOld)
    throw new EvalCorpusError(
      `${where}.pair: oldVersion, oldIntegrity and oldResolvedUrl must be all null or all present`,
    );
  return {
    name,
    oldVersion,
    newVersion,
    oldIntegrity,
    newIntegrity,
    oldResolvedUrl,
    resolvedUrl,
  };
}

function parseOverride(value: unknown, where: string): ResultOverride {
  const raw = asRecord(value, `${where}.resultOverride`);
  const counts = asRecord(
    raw.gateSeverity,
    `${where}.resultOverride.gateSeverity`,
  );
  const gateSeverity: Record<Severity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
  };
  for (const severity of SEVERITIES) {
    const count = counts[severity];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new EvalCorpusError(
        `${where}.resultOverride.gateSeverity.${severity}: expected a non-negative integer`,
      );
    gateSeverity[severity] = count;
  }
  const incomplete = raw.incomplete;
  if (typeof incomplete !== "boolean")
    throw new EvalCorpusError(
      `${where}.resultOverride.incomplete: expected a boolean`,
    );
  return { gateSeverity, incomplete };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new EvalCorpusError(`${where}: expected an object`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new EvalCorpusError(`${where}: expected a non-empty string`);
  return value;
}

function asNullableString(value: unknown, where: string): string | null {
  if (value === null) return null;
  return asString(value, where);
}

export function assignHeldOut(
  entries: readonly Omit<EvalEntry, "heldOut">[],
  rule: { fraction: number; salt: string },
): EvalEntry[] {
  if (!Number.isFinite(rule.fraction) || rule.fraction < 0 || rule.fraction > 1)
    throw new EvalCorpusError("held-out fraction must be between 0 and 1");
  if (rule.salt.length === 0)
    throw new EvalCorpusError("held-out salt must not be empty");
  return entries.map((entry) => ({
    ...entry,
    heldOut: bucketFor(entry.id, rule.salt) < rule.fraction,
  }));
}

function bucketFor(id: string, salt: string): number {
  const digest = createHash("sha256").update(`${salt}${id}`).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) / 2 ** 32;
}

export function computeMetrics(
  entries: readonly EvalEntry[],
  results: readonly EntryResult[],
): MetricsReport {
  const resolved = resolveEntries(entries, results);
  return {
    all: metricsFor(resolved),
    heldOut: metricsFor(resolved.filter((item) => item.entry.heldOut)),
    development: metricsFor(resolved.filter((item) => !item.entry.heldOut)),
    byProvenance: groupByProvenance(resolved),
  };
}

interface ResolvedEntry {
  entry: EvalEntry;
  result: EntryResult;
}

function resolveEntries(
  entries: readonly EvalEntry[],
  results: readonly EntryResult[],
): ResolvedEntry[] {
  const byId = new Map<string, EntryResult>();
  for (const result of results) {
    if (byId.has(result.id))
      throw new EvalMetricsError(
        `duplicate result for entry ${JSON.stringify(truncate(result.id, MAX_IDENTITY_CHARS))}`,
      );
    byId.set(result.id, result);
  }
  return entries.map((entry) => {
    const result = byId.get(entry.id);
    if (result === undefined)
      throw new EvalMetricsError(
        `no result for entry ${JSON.stringify(truncate(entry.id, MAX_IDENTITY_CHARS))}`,
      );
    return { entry, result };
  });
}

function resultFromOverride(entry: EvalEntry): EntryResult | undefined {
  const override = entry.resultOverride;
  if (override === undefined) return undefined;
  return {
    id: entry.id,
    analyzed: true,
    gateCritical: override.gateSeverity.CRITICAL > 0,
    maxSeverity: highestSeverity(override.gateSeverity),
    incomplete: override.incomplete,
  };
}

function highestSeverity(counts: Record<Severity, number>): MaxSeverity {
  for (const severity of SEVERITIES) if (counts[severity] > 0) return severity;
  return "NONE";
}

function groupByProvenance(
  resolved: readonly ResolvedEntry[],
): Record<string, Metrics> {
  const groups = new Map<string, ResolvedEntry[]>();
  for (const item of resolved) {
    const group = groups.get(item.entry.provenance) ?? [];
    group.push(item);
    groups.set(item.entry.provenance, group);
  }
  const byProvenance: Record<string, Metrics> = {};
  for (const [provenance, group] of groups)
    byProvenance[provenance] = metricsFor(group);
  return byProvenance;
}

function metricsFor(resolved: readonly ResolvedEntry[]): Metrics {
  const analyzed = resolved.filter((item) => item.result.analyzed);
  const incomplete = resolved.filter(
    (item) => !item.result.analyzed || item.result.incomplete,
  ).length;
  const malicious = analyzed.filter((item) => item.entry.label === "malicious");
  const benign = analyzed.filter((item) => item.entry.label === "benign");
  const detected = malicious.filter((item) => isDetected(item.result));
  const detectedAtGate = malicious.filter((item) => item.result.gateCritical);
  const flagged = benign.filter((item) => isDetected(item.result));
  const flaggedAtGate = benign.filter((item) => item.result.gateCritical);
  return {
    total: resolved.length,
    analyzed: analyzed.length,
    incompleteRate: resolved.length === 0 ? 0 : incomplete / resolved.length,
    recall: rate(detected.length, malicious.length),
    recallAtGate: rate(detectedAtGate.length, malicious.length),
    falsePositive: flagRate(flagged.length, benign.length),
    falsePositiveAtGate: flagRate(flaggedAtGate.length, benign.length),
    missed: malicious
      .filter((item) => !isDetected(item.result))
      .map((item) => item.entry.id)
      .sort(compareText),
    falsePositiveIds: flagged.map((item) => item.entry.id).sort(compareText),
  };
}

function isDetected(result: EntryResult): boolean {
  return result.maxSeverity === "HIGH" || result.maxSeverity === "CRITICAL";
}

function rate(detected: number, of: number): Rate {
  return { detected, of, rate: of === 0 ? null : detected / of };
}

function flagRate(flagged: number, of: number): FlagRate {
  return { flagged, of, rate: of === 0 ? null : flagged / of };
}

const Z_95 = 1.959963984540054;

export function wilsonInterval(
  successes: number,
  total: number,
): { low: number; high: number } | null {
  if (total <= 0) return null;
  if (!Number.isSafeInteger(successes) || successes < 0 || successes > total)
    throw new EvalMetricsError("wilsonInterval needs 0 <= successes <= total");
  const proportion = successes / total;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / total;
  const center = (proportion + z2 / (2 * total)) / denominator;
  const spread =
    (Z_95 *
      Math.sqrt(
        (proportion * (1 - proportion)) / total + z2 / (4 * total * total),
      )) /
    denominator;
  return {
    low: Math.max(0, center - spread),
    high: Math.min(1, center + spread),
  };
}

export function renderReport(
  corpus: EvalCorpus,
  results: readonly EntryResult[],
  identity: { generatedAt: string; commit: string },
): string {
  const provided = new Map(results.map((result) => [result.id, result]));
  const resolved = corpus.entries.map((entry) => {
    const result = provided.get(entry.id) ?? resultFromOverride(entry);
    if (result === undefined)
      throw new EvalMetricsError(
        `no result for entry ${JSON.stringify(truncate(entry.id, MAX_IDENTITY_CHARS))}`,
      );
    return { entry, result };
  });
  const metrics = computeMetrics(
    corpus.entries,
    resolved.map((item) => item.result),
  );
  const synthetic = resolved.filter(
    (item) => item.entry.provenance === "synthetic-reconstruction",
  );
  const lines = [
    "# Labeled evaluation report",
    "",
    `Generated at ${identity.generatedAt} from commit ${identity.commit}.`,
    `Corpus created at ${truncate(corpus.createdAt, MAX_VALUE_CHARS)}. Split rule: ${truncate(corpus.splitRule, MAX_VALUE_CHARS)}.`,
    "",
    "## Metrics",
    "",
    "| Measure | All | Held-out | Development |",
    "| --- | ---: | ---: | ---: |",
    row(
      "Entries",
      metrics.all.total,
      metrics.heldOut.total,
      metrics.development.total,
    ),
    row(
      "Analyzed",
      metrics.all.analyzed,
      metrics.heldOut.analyzed,
      metrics.development.analyzed,
    ),
    row(
      "Incomplete or unavailable",
      formatPercent(metrics.all.incompleteRate),
      formatPercent(metrics.heldOut.incompleteRate),
      formatPercent(metrics.development.incompleteRate),
    ),
    row(
      "Recall (HIGH or CRITICAL)",
      formatRate(metrics.all.recall),
      formatRate(metrics.heldOut.recall),
      formatRate(metrics.development.recall),
    ),
    row(
      "Recall at the default gate",
      formatRate(metrics.all.recallAtGate),
      formatRate(metrics.heldOut.recallAtGate),
      formatRate(metrics.development.recallAtGate),
    ),
    row(
      "False positives (HIGH or CRITICAL)",
      formatRate(metrics.all.falsePositive),
      formatRate(metrics.heldOut.falsePositive),
      formatRate(metrics.development.falsePositive),
    ),
    row(
      "False positives at the default gate",
      formatRate(metrics.all.falsePositiveAtGate),
      formatRate(metrics.heldOut.falsePositiveAtGate),
      formatRate(metrics.development.falsePositiveAtGate),
    ),
    "",
    "## Missed malicious entries",
    "",
  ];
  appendIds(lines, metrics.all.missed);
  lines.push("", "## False positives", "");
  appendIds(lines, metrics.all.falsePositiveIds);
  lines.push("", "## Synthetic reconstruction results", "");
  if (synthetic.length === 0) lines.push("None.");
  for (const item of synthetic) {
    lines.push(
      `- ${JSON.stringify(truncate(item.entry.id, MAX_IDENTITY_CHARS))}: max severity ${item.result.maxSeverity}, gate fails ${yesNo(item.result.gateCritical)}, incomplete ${yesNo(item.result.incomplete)}, source ${JSON.stringify(truncate(item.entry.source, MAX_VALUE_CHARS))}`,
    );
  }
  const realCount = resolved.length - synthetic.length;
  lines.push(
    "",
    "## Limits",
    "",
    `- Corpus sizes: ${String(metrics.all.total)} entries, ${String(metrics.heldOut.total)} held out and ${String(metrics.development.total)} in development; ${String(realCount)} real-registry and ${String(synthetic.length)} synthetic-reconstruction.`,
    "- Held-out entries must not be used to tune detections. Read the development and held-out columns separately.",
    "- A rate is null when its denominator is zero, shown as n/a. Each rate carries a Wilson 95% interval.",
    "- Recall and false-positive rates use analyzed entries only. The default gate fails on CRITICAL, with strict mode off.",
    "- Missed counts analyzed malicious entries. An unavailable entry is counted in the incomplete rate, not as a miss.",
    "- Synthetic entries carry results supplied by reconstruction tests. The tool does not run them against the registry.",
  );
  return `${lines.join("\n")}\n`;
}

function row(
  measure: string,
  all: string | number,
  heldOut: string | number,
  development: string | number,
): string {
  return `| ${measure} | ${String(all)} | ${String(heldOut)} | ${String(development)} |`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatRate(value: Rate | FlagRate): string {
  if (value.rate === null) return "n/a (0 of 0)";
  const count = "detected" in value ? value.detected : value.flagged;
  const interval = wilsonInterval(count, value.of);
  const bounds =
    interval === null
      ? ""
      : `, Wilson 95% ${formatPercent(interval.low)} to ${formatPercent(interval.high)}`;
  return `${String(count)} of ${String(value.of)} (${formatPercent(value.rate)}${bounds})`;
}

function appendIds(lines: string[], ids: readonly string[]): void {
  if (ids.length === 0) {
    lines.push("None.");
    return;
  }
  for (const id of ids)
    lines.push(`- ${JSON.stringify(truncate(id, MAX_IDENTITY_CHARS))}`);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
