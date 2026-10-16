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
import { NamedError } from "./named-error.js";

/** A reviewed exception matched to an unavailable package (ADR-017 §2). */
export interface UnanalyzableException {
  reason: string;
}

export class UnanalyzableExceptionError extends NamedError {}

/**
 * ADR-017 §2 as amended: mark an unavailable package as reviewed only when
 * every severity-bearing failure is a post-verification (extraction or
 * manifest) failure that matches a config entry on the failure side's exact
 * version and lockfile integrity, at least one match is on the **new** side,
 * and no failure is from the fetch stage. The pass never touches analyzed
 * packages and never deletes a failure.
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
  // Amendment C.3: a fetch-stage failure (including `integrity-mismatch`) is
  // decided before or without byte verification, so the package can never
  // carry a reviewed exception.
  if (item.failures.some((failure) => failure.stage === "fetch")) return null;
  let matchedNew: UnanalyzableExceptionEntry | null = null;
  for (const failure of item.failures) {
    const severity = analysisIssueSeverity({
      stage: failure.stage,
      kind: failure.failure.kind,
    });
    // Only severity-bearing failures are reviewed; a transient failure
    // (network, deadline, cleanup) neither matches nor blocks an exception.
    if (severity === null) continue;
    // Amendment C.1: every severity-bearing failure must come from the
    // extraction or manifest stage. Fetch failures are already excluded above;
    // this guards a future stage whose severity is raised.
    const side = failureSide(failure);
    if (side === null) return null;
    const entry = matchFailure(item, failure, entries);
    // One unmatched severity-bearing failure (including a never-exceptable
    // integrity mismatch) keeps the package gating.
    if (entry === null) return null;
    // Amendment C.2: the exception must bind the new subject. Track whether
    // any matched failure is on the new side.
    if (side === "new") matchedNew ??= entry;
  }
  if (matchedNew === null) return null;
  // The scope leads the reason so report truncation can never hide it. The
  // reason names the new-side entry that binds the exception.
  return {
    reason: `[version ${matchedNew.version}] ${matchedNew.justification}`,
  };
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
