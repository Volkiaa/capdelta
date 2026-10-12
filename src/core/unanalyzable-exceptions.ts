import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
  UnavailablePackage,
} from "./capability-analysis-pipeline.js";
import type {
  CapdeltaConfig,
  UnanalyzableExceptionEntry,
} from "./capdelta-config.js";
import { analysisIssueSeverity } from "./run-severity.js";

/** A reviewed exception matched to an unavailable package (ADR-017 §2). */
export interface UnanalyzableException {
  reason: string;
}

export class UnanalyzableExceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * ADR-017 §2: mark an unavailable package as reviewed when every
 * severity-bearing failure matches a config entry on package, kind, the
 * failure side's exact version, and that side's exact lockfile integrity. The
 * pass never touches analyzed packages and never deletes a failure.
 */
export function applyUnanalyzableExceptions(
  run: CapabilityAnalysisRun,
  config: CapdeltaConfig,
): CapabilityAnalysisRun {
  if (config.unanalyzable.length === 0) return run;
  const packages = run.packages.map((item) => {
    if (item.status !== "unavailable") return item;
    const exception = matchUnavailablePackage(item, config.unanalyzable);
    return exception === null ? item : { ...item, exception };
  });
  return { ...run, packages };
}

function matchUnavailablePackage(
  item: UnavailablePackage,
  entries: readonly UnanalyzableExceptionEntry[],
): UnanalyzableException | null {
  let matched: UnanalyzableExceptionEntry | null = null;
  let severityBearing = 0;
  for (const failure of item.failures) {
    const severity = analysisIssueSeverity({
      stage: failure.stage,
      kind: failure.failure.kind,
    });
    // Only severity-bearing failures are reviewed; a transient failure
    // (network, deadline, cleanup) neither matches nor blocks an exception.
    if (severity === null) continue;
    severityBearing += 1;
    const entry = matchFailure(item, failure, entries);
    // ADR-017 §2: one unmatched severity-bearing failure (including a never
    // exceptable integrity mismatch) keeps the package gating.
    if (entry === null) return null;
    matched ??= entry;
  }
  if (matched === null || severityBearing === 0) return null;
  // The scope leads the reason so report truncation can never hide it.
  return { reason: `[version ${matched.version}] ${matched.justification}` };
}

function matchFailure(
  item: UnavailablePackage,
  failure: PackageAnalysisFailure,
  entries: readonly UnanalyzableExceptionEntry[],
): UnanalyzableExceptionEntry | null {
  const side = failureSide(failure);
  if (side === null) return null;
  const version =
    side === "old"
      ? item.changedPackage.oldVersion
      : item.changedPackage.newVersion;
  const integrity =
    side === "old"
      ? item.changedPackage.oldIntegrity
      : item.changedPackage.newIntegrity;
  if (version === null || integrity === null) return null;
  const kind = failure.failure.kind;
  return (
    entries.find(
      (entry) =>
        entry.package === item.changedPackage.name &&
        entry.kind === kind &&
        entry.version === version &&
        entry.integrity === integrity,
    ) ?? null
  );
}

function failureSide(failure: PackageAnalysisFailure): "old" | "new" | null {
  switch (failure.stage) {
    case "fetch":
      return failure.failure.side;
    case "old-extraction":
    case "old-manifest":
    case "old-cleanup":
      return "old";
    case "new-extraction":
    case "new-manifest":
    case "new-cleanup":
      return "new";
    case "analysis":
      return null;
    default: {
      const unclassified: never = failure;
      throw new UnanalyzableExceptionError(
        `unclassified analysis failure stage ${JSON.stringify(unclassified)}`,
      );
    }
  }
}
