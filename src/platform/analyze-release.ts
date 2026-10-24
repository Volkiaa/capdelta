import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
  type CapabilityAnalysisOptions,
  type CapabilityAnalysisRun,
} from "../core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../core/contract/lockfile-diff.js";
import { NamedError } from "../core/named-error.js";
import {
  buildRunReport,
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import { hasOperationalFailure } from "../core/run-severity.js";
import { ANALYZER_VERSION } from "./analyzer-version.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import {
  releaseKey,
  type ReleaseRecord,
  type ReleaseStore,
} from "./release-store.js";

/** The caller should retry; nothing was stored. */
export class TransientAnalysisError extends NamedError {}

export interface AnalyzeReleaseDeps {
  store: ReleaseStore;
  analyze?: typeof analyzeChangedPackages;
  analyzeOptions?: CapabilityAnalysisOptions;
  now?: () => Date;
  analyzerVersion?: string;
}

export async function analyzeRelease(
  candidate: ReleaseCandidate,
  deps: AnalyzeReleaseDeps,
): Promise<{ record: ReleaseRecord; created: boolean }> {
  const analyzerVersion = deps.analyzerVersion ?? ANALYZER_VERSION;
  const key = releaseKey(candidate, analyzerVersion);
  const existing = await deps.store.get(key);
  if (existing !== null) return { record: existing, created: false };

  const analyze = deps.analyze ?? analyzeChangedPackages;
  const run = await analyze(
    {
      changed: [toChangedPackage(candidate)],
      findings: [],
      skipped: [],
      firstRun: false,
    },
    deps.analyzeOptions,
  );

  if (hasOperationalFailure(run)) {
    const causes = run.packages
      .flatMap((item) => (item.status === "unavailable" ? item.failures : []))
      .map((failure) => `${failure.stage}:${failure.failure.kind}`);
    throw new TransientAnalysisError(
      truncate(
        `analysis of ${releaseIdentity(candidate)} failed operationally (${causes.join(", ")}); retry`,
        MAX_VALUE_CHARS,
      ),
    );
  }

  const incomplete = hasUnanalyzedContent(run) || run.budget?.partial === true;
  const record: ReleaseRecord = {
    schemaVersion: 1,
    ecosystem: "npm",
    name: candidate.name,
    version: candidate.version,
    digest: candidate.digest,
    previousVersion: candidate.previous?.version ?? null,
    previousDigest: candidate.previous?.digest ?? null,
    analyzerVersion,
    analyzedAt: (deps.now?.() ?? new Date()).toISOString(),
    status: incomplete ? "incomplete" : "complete",
    incompleteReasons: incomplete ? unavailableReasons(run) : [],
    report: buildRunReport(run),
  };

  if (await deps.store.putIfAbsent(record)) return { record, created: true };

  const winner = await deps.store.get(key);
  if (winner === null) {
    throw new TransientAnalysisError(
      `release record for ${releaseIdentity(candidate)} disappeared during a concurrent write; retry`,
    );
  }
  return { record: winner, created: false };
}

/** A release with no previous version: full capability snapshot. */
export function analyzeArtifact(
  candidate: ReleaseCandidate,
  deps: AnalyzeReleaseDeps,
): ReturnType<typeof analyzeRelease> {
  return analyzeRelease({ ...candidate, previous: null }, deps);
}

function toChangedPackage(candidate: ReleaseCandidate): ChangedPackage {
  const previous = candidate.previous;
  return {
    name: candidate.name,
    oldVersion: previous?.version ?? null,
    newVersion: candidate.version,
    oldIntegrity: previous?.digest ?? null,
    newIntegrity: candidate.digest,
    oldResolvedUrl: previous?.tarballUrl ?? null,
    resolvedUrl: candidate.tarballUrl,
  };
}

function unavailableReasons(run: CapabilityAnalysisRun): string[] {
  const reasons: string[] = [];
  for (const item of run.packages) {
    if (item.status !== "unavailable") continue;
    for (const failure of item.failures) {
      const reason = truncate(
        `${failure.stage}: ${failure.failure.kind}`,
        MAX_VALUE_CHARS,
      );
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return reasons;
}

function releaseIdentity(candidate: ReleaseCandidate): string {
  return `${truncate(candidate.name, MAX_IDENTITY_CHARS)}@${truncate(candidate.version, MAX_IDENTITY_CHARS)}`;
}
