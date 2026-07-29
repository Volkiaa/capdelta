import type {
  ChangedPackage,
  LockfileDiffResult,
  LockfileFinding,
  SkippedPackage,
} from "./contract/lockfile-diff.js";
import type {
  CapabilitySet,
  PackageSubject,
} from "./contract/capability-set.js";
import {
  AnalysisExecutionPolicyConfigurationError,
  analysisStopDetail,
  analysisStopKind,
  resolveAnalysisExecutionPolicy,
  startAnalysisRun,
  type AnalysisExecutionPolicy,
  type AnalysisStopKind,
  type ResolvedAnalysisExecutionPolicy,
} from "./analysis-execution-policy.js";
import {
  diffCapabilities,
  type CapabilityDiffResult,
} from "./capability-differ.js";
import {
  fetchChangedPackages,
  type FetchFailure,
  type FetchPackageResult,
  type FetcherOptions,
  type VerifiedTarball,
} from "./npm/fetcher.js";
import {
  extractVerifiedManifest,
  extractVerifiedTarball,
  type ExtractedTarball,
  type ExtractionFailure,
  type ExtractionResult,
  type ExtractorOptions,
} from "./npm/safe-extractor.js";
import {
  extractNpmManifestCapabilities,
  type ManifestCapabilityExtractorOptions,
  type ManifestCapabilityFailure,
  type ManifestCapabilityResult,
} from "./npm/manifest-capability-extractor.js";
import {
  extractNpmJavaScriptCapabilities,
  mergeJavaScriptCapabilityLayer,
  type AstExtractionOptions,
  type JavaScriptCapabilityLayerResult,
} from "./npm/javascript-capability-extractor.js";
import {
  applyCapabilityAllowlist,
  emptyCapdeltaConfig,
  type CapdeltaConfig,
} from "./capdelta-config.js";

export type AnalysisSide = "old" | "new";

export type PackageAnalysisFailure =
  | { stage: "fetch"; failure: FetchFailure }
  | {
      stage: "analysis";
      failure: { kind: AnalysisStopKind; detail: string };
    }
  | {
      stage: "old-extraction" | "new-extraction";
      failure: ExtractionFailure;
    }
  | {
      stage: "old-manifest" | "new-manifest";
      failure: ManifestCapabilityFailure;
    }
  | {
      stage: "old-cleanup" | "new-cleanup";
      failure: { kind: "cleanup-failed"; detail: string };
    };

export interface AnalyzedPackage {
  status: "analyzed";
  changedPackage: ChangedPackage;
  diff: CapabilityDiffResult;
  /** Non-fatal but loud issues, currently cleanup failures after analysis. */
  issues: readonly PackageAnalysisFailure[];
}

export interface UnavailablePackage {
  status: "unavailable";
  changedPackage: ChangedPackage;
  failures: readonly [PackageAnalysisFailure, ...PackageAnalysisFailure[]];
}

export type PackageAnalysisResult = AnalyzedPackage | UnavailablePackage;

export interface CapabilityAnalysisRun {
  firstRun: boolean;
  summary: {
    changed: number;
    analyzed: number;
    unavailable: number;
    skipped: number;
  };
  packages: readonly PackageAnalysisResult[];
  lockfileFindings: readonly LockfileFinding[];
  skipped: readonly SkippedPackage[];
  /** Loud accounting for the bounded scheduler (PLAN §2). */
  budget?: AnalysisBudgetSummary;
}

export interface AnalysisBudgetSummary {
  deadlineMs: number;
  prioritization: "install-script-first";
  startedPackages: number;
  completedPackages: number;
  unstartedPackages: number;
  deadlineExceeded: boolean;
  partial: boolean;
}

export interface CapabilityAnalysisOptions {
  execution?: AnalysisExecutionPolicy;
  fetcher?: FetcherOptions;
  extractor?: ExtractorOptions;
  manifestExtractor?: ManifestCapabilityExtractorOptions;
  astExtractor?: AstExtractionOptions;
  /** PLAN §2 default: at most four packages extracting concurrently. */
  extractionConcurrency?: number;
  /** Reviewed policy exceptions are rendered, never removed. */
  config?: CapdeltaConfig;
}

/** Strict mode treats every unanalysed input as a distinct failure class. */
export function hasUnanalyzedContent(run: CapabilityAnalysisRun): boolean {
  return (
    run.summary.unavailable > 0 ||
    run.summary.skipped > 0 ||
    run.packages.some((item) =>
      item.status === "analyzed"
        ? item.issues.length > 0 || item.diff.diagnostics.length > 0
        : true,
    ) ||
    run.budget?.partial === true
  );
}

export class CapabilityAnalysisPipelineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Preserve the M1 observable error names while the exported constructors
    // remain identity aliases for instanceof compatibility.
    this.name = new.target.name.replace(
      /^CapabilityAnalysis/u,
      "ManifestAnalysis",
    );
  }
}

export class CapabilityAnalysisPipelineConfigurationError extends CapabilityAnalysisPipelineError {}

export class CapabilityAnalysisPipelineContractError extends CapabilityAnalysisPipelineError {}

interface CapabilityAnalysisAdapters {
  fetch(
    packages: readonly ChangedPackage[],
    options: FetcherOptions,
  ): Promise<FetchPackageResult[]>;
  extract(
    tarball: VerifiedTarball,
    options: ExtractorOptions,
  ): Promise<ExtractionResult>;
  extractManifestOnly?(
    tarball: VerifiedTarball,
    options: ExtractorOptions,
  ): Promise<ExtractionResult>;
  extractManifest(
    extracted: Pick<ExtractedTarball, "root">,
    expected: PackageSubject,
    options: ManifestCapabilityExtractorOptions,
  ): Promise<ManifestCapabilityResult>;
  extractJavaScript(
    extracted: Pick<ExtractedTarball, "root">,
    manifestSet: CapabilitySet,
    options: AstExtractionOptions,
  ): Promise<JavaScriptCapabilityLayerResult>;
  diff(
    oldSet: CapabilitySet | null,
    newSet: CapabilitySet,
  ): CapabilityDiffResult;
}

interface ResolvedPipelineOptions {
  execution: ResolvedAnalysisExecutionPolicy;
  fetcher: FetcherOptions;
  extractor: ExtractorOptions;
  manifestExtractor: ManifestCapabilityExtractorOptions;
  astExtractor: AstExtractionOptions;
  config: CapdeltaConfig;
}

interface SideAnalysisSuccess {
  ok: true;
  set: CapabilitySet;
  issues: PackageAnalysisFailure[];
}

interface SideAnalysisFailure {
  ok: false;
  failures: [PackageAnalysisFailure, ...PackageAnalysisFailure[]];
}

interface ManifestPreflightReady {
  status: "ready";
  changedPackage: ChangedPackage;
  newManifest: CapabilitySet;
  hasInstallScript: boolean;
  issues: PackageAnalysisFailure[];
}

interface ManifestPreflightUnavailable {
  status: "unavailable";
  changedPackage: ChangedPackage;
  failures: [PackageAnalysisFailure, ...PackageAnalysisFailure[]];
}

type ManifestPreflightResult =
  ManifestPreflightReady | ManifestPreflightUnavailable;

type SideAnalysisResult = SideAnalysisSuccess | SideAnalysisFailure;

const DEFAULT_ADAPTERS: CapabilityAnalysisAdapters = {
  fetch: fetchChangedPackages,
  extract: extractVerifiedTarball,
  extractManifestOnly: extractVerifiedManifest,
  extractManifest: extractNpmManifestCapabilities,
  extractJavaScript: extractNpmJavaScriptCapabilities,
  diff: diffCapabilities,
};

/**
 * Fetches, safely extracts, and capability-diffs every analyzable lockfile change.
 * Package-local failures are returned and processing continues (PLAN §2).
 */
export const analyzeChangedPackages =
  createCapabilityAnalysisPipeline(DEFAULT_ADAPTERS);

/** Internal construction seam used by inert orchestration tests. */
export function createCapabilityAnalysisPipeline(
  adapters: CapabilityAnalysisAdapters,
): (
  lockfileDiff: LockfileDiffResult,
  options?: CapabilityAnalysisOptions,
) => Promise<CapabilityAnalysisRun> {
  return async (
    lockfileDiff: LockfileDiffResult,
    options: CapabilityAnalysisOptions = {},
  ): Promise<CapabilityAnalysisRun> => {
    const resolved = resolvePipelineOptions(options);
    const control = startAnalysisRun(resolved.execution);
    try {
      const fetched = await callWithContext("package fetch batch", () =>
        adapters.fetch(lockfileDiff.changed, {
          ...resolved.fetcher,
          signal: control.signal,
        }),
      );
      validateFetchResults(lockfileDiff.changed, fetched);

      const preflighted = new Array<ManifestPreflightResult>(fetched.length);
      let nextPreflightPosition = 0;
      let startedPackages = 0;
      let completedPackages = 0;
      const workerCount = Math.min(
        resolved.execution.extraction.concurrency,
        fetched.length,
      );
      const preflightOrder = prioritizePreflightPackages(fetched, lockfileDiff);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const index = preflightOrder[nextPreflightPosition];
            nextPreflightPosition += 1;
            if (index === undefined) return;
            const fetchedPackage = fetched[index];
            if (fetchedPackage === undefined) {
              throw new CapabilityAnalysisPipelineContractError(
                `preflight selected missing fetched package at index ${String(index)}`,
              );
            }
            if (control.signal.aborted) {
              preflighted[index] = preflightStopped(
                fetchedPackage.changedPackage,
                control.signal,
              );
            } else {
              startedPackages += 1;
              preflighted[index] = await preflightFetchedPackage(
                fetchedPackage,
                resolved,
                control.signal,
                adapters,
              );
            }
          }
        }),
      );

      const packages = new Array<PackageAnalysisResult>(fetched.length);
      const workOrder = prioritizePackages(fetched, preflighted);
      let nextWorkPosition = 0;
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const index = workOrder[nextWorkPosition];
            nextWorkPosition += 1;
            if (index === undefined) return;
            const fetchedPackage = fetched[index];
            if (fetchedPackage === undefined) {
              throw new CapabilityAnalysisPipelineContractError(
                `scheduler selected missing fetched package at index ${String(index)}`,
              );
            }
            const preflight = preflighted[index];
            if (preflight === undefined) {
              throw new CapabilityAnalysisPipelineContractError(
                `preflight returned no result at index ${String(index)}`,
              );
            }
            packages[index] = control.signal.aborted
              ? policyUnavailable(
                  fetchedPackage.changedPackage,
                  control.signal,
                  preflight.status === "ready"
                    ? preflight.issues
                    : preflight.failures,
                )
              : preflight.status === "unavailable"
                ? {
                    status: "unavailable",
                    changedPackage: preflight.changedPackage,
                    failures: preflight.failures,
                  }
                : await analyzeFetchedPackage(
                    fetchedPackage,
                    resolved,
                    control.signal,
                    adapters,
                    preflight,
                  );
            completedPackages += 1;
          }
        }),
      );

      const analyzed = packages.filter(
        (result) => result.status === "analyzed",
      ).length;
      return {
        firstRun: lockfileDiff.firstRun,
        summary: {
          changed: lockfileDiff.changed.length,
          analyzed,
          unavailable: packages.length - analyzed,
          skipped: lockfileDiff.skipped.length,
        },
        packages,
        lockfileFindings: lockfileDiff.findings,
        skipped: lockfileDiff.skipped,
        budget: {
          deadlineMs: resolved.execution.deadlineMs,
          prioritization: "install-script-first",
          startedPackages,
          completedPackages,
          unstartedPackages: fetched.length - startedPackages,
          deadlineExceeded:
            analysisStopKind(control.signal) === "deadline-exceeded",
          partial:
            analysisStopKind(control.signal) !== null ||
            startedPackages < fetched.length,
        },
      };
    } finally {
      control.dispose();
    }
  };
}

function resolvePipelineOptions(
  options: CapabilityAnalysisOptions,
): ResolvedPipelineOptions {
  rejectPolicyConflicts(options);
  if (
    options.fetcher?.signal !== undefined ||
    options.extractor?.signal !== undefined ||
    options.manifestExtractor?.signal !== undefined ||
    options.astExtractor?.signal !== undefined
  ) {
    throw new CapabilityAnalysisPipelineConfigurationError(
      "stage signals are managed by execution.signal",
    );
  }
  try {
    const defaults = resolveAnalysisExecutionPolicy(options.execution);
    const execution = resolveAnalysisExecutionPolicy({
      deadlineMs: defaults.deadlineMs,
      ...(defaults.signal === undefined ? {} : { signal: defaults.signal }),
      fetch: {
        concurrency: options.fetcher?.concurrency ?? defaults.fetch.concurrency,
        timeoutMs: options.fetcher?.timeoutMs ?? defaults.fetch.timeoutMs,
        maxTarballBytes:
          options.fetcher?.maxTarballBytes ?? defaults.fetch.maxTarballBytes,
      },
      extraction: {
        concurrency:
          options.extractionConcurrency ?? defaults.extraction.concurrency,
        maxFileCount:
          options.extractor?.maxFileCount ?? defaults.extraction.maxFileCount,
        maxExpandedBytes:
          options.extractor?.maxExpandedBytes ??
          defaults.extraction.maxExpandedBytes,
        maxDecompressionRatio:
          options.extractor?.maxDecompressionRatio ??
          defaults.extraction.maxDecompressionRatio,
      },
      manifest: {
        maxBytes:
          options.manifestExtractor?.maxManifestBytes ??
          defaults.manifest.maxBytes,
      },
      javascript: {
        maxSourceBytes:
          options.astExtractor?.maxSourceBytes ??
          defaults.javascript.maxSourceBytes,
        parseTimeoutMs:
          options.astExtractor?.parseTimeoutMs ??
          defaults.javascript.parseTimeoutMs,
      },
    });
    return {
      execution,
      fetcher: {
        ...(options.fetcher?.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetcher.fetchImpl }),
        ...(options.fetcher?.cache === undefined
          ? {}
          : { cache: options.fetcher.cache }),
        ...execution.fetch,
      },
      extractor: {
        maxFileCount: execution.extraction.maxFileCount,
        maxExpandedBytes: execution.extraction.maxExpandedBytes,
        maxDecompressionRatio: execution.extraction.maxDecompressionRatio,
      },
      manifestExtractor: { maxManifestBytes: execution.manifest.maxBytes },
      astExtractor: execution.javascript,
      config: options.config ?? emptyCapdeltaConfig(),
    };
  } catch (error: unknown) {
    if (error instanceof AnalysisExecutionPolicyConfigurationError) {
      throw new CapabilityAnalysisPipelineConfigurationError(error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

function rejectPolicyConflicts(options: CapabilityAnalysisOptions): void {
  const policy = options.execution;
  const conflicts: readonly (readonly [string, unknown, unknown])[] = [
    [
      "fetch.concurrency",
      policy?.fetch?.concurrency,
      options.fetcher?.concurrency,
    ],
    ["fetch.timeoutMs", policy?.fetch?.timeoutMs, options.fetcher?.timeoutMs],
    [
      "fetch.maxTarballBytes",
      policy?.fetch?.maxTarballBytes,
      options.fetcher?.maxTarballBytes,
    ],
    [
      "extraction.concurrency",
      policy?.extraction?.concurrency,
      options.extractionConcurrency,
    ],
    [
      "extraction.maxFileCount",
      policy?.extraction?.maxFileCount,
      options.extractor?.maxFileCount,
    ],
    [
      "extraction.maxExpandedBytes",
      policy?.extraction?.maxExpandedBytes,
      options.extractor?.maxExpandedBytes,
    ],
    [
      "extraction.maxDecompressionRatio",
      policy?.extraction?.maxDecompressionRatio,
      options.extractor?.maxDecompressionRatio,
    ],
    [
      "manifest.maxBytes",
      policy?.manifest?.maxBytes,
      options.manifestExtractor?.maxManifestBytes,
    ],
    [
      "javascript.maxSourceBytes",
      policy?.javascript?.maxSourceBytes,
      options.astExtractor?.maxSourceBytes,
    ],
    [
      "javascript.parseTimeoutMs",
      policy?.javascript?.parseTimeoutMs,
      options.astExtractor?.parseTimeoutMs,
    ],
  ];
  const duplicate = conflicts.find(
    ([, policyValue, legacyValue]) =>
      policyValue !== undefined && legacyValue !== undefined,
  );
  if (duplicate !== undefined) {
    throw new CapabilityAnalysisPipelineConfigurationError(
      `${duplicate[0]} is configured in both execution policy and legacy options`,
    );
  }
}

function validateFetchResults(
  expected: readonly ChangedPackage[],
  actual: readonly FetchPackageResult[],
): void {
  if (actual.length !== expected.length) {
    throw new CapabilityAnalysisPipelineContractError(
      `Fetcher returned ${String(actual.length)} results for ${String(expected.length)} packages`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedPackage = expected[index];
    const actualPackage = actual[index]?.changedPackage;
    if (
      expectedPackage === undefined ||
      actualPackage === undefined ||
      !sameChangedPackage(expectedPackage, actualPackage)
    ) {
      throw new CapabilityAnalysisPipelineContractError(
        `Fetcher result ${String(index)} does not match its input package`,
      );
    }
  }
}

function sameChangedPackage(
  left: ChangedPackage,
  right: ChangedPackage,
): boolean {
  return (
    left.name === right.name &&
    left.oldVersion === right.oldVersion &&
    left.newVersion === right.newVersion &&
    left.oldIntegrity === right.oldIntegrity &&
    left.newIntegrity === right.newIntegrity &&
    left.oldResolvedUrl === right.oldResolvedUrl &&
    left.resolvedUrl === right.resolvedUrl
  );
}

function prioritizePackages(
  fetched: readonly FetchPackageResult[],
  preflighted: readonly (ManifestPreflightResult | undefined)[],
): number[] {
  // The manifest preflight makes the PLAN §2 heuristic observable: packages
  // with registry install hooks are processed first, then smaller verified
  // downloads, then original lockfile order. Lockfile facts are retained as
  // the preflight order for deadline behavior, not as a hidden priority.
  return fetched
    .map((item, index) => ({
      index,
      hasInstallScript:
        preflighted[index]?.status === "ready" &&
        preflighted[index].hasInstallScript,
      downloadBytes:
        item.status === "verified"
          ? item.newTarball.bytes.length +
            (item.oldTarball === null ? 0 : item.oldTarball.bytes.length)
          : Number.MAX_SAFE_INTEGER,
      name: item.changedPackage.name,
    }))
    .sort(
      (left, right) =>
        Number(right.hasInstallScript) - Number(left.hasInstallScript) ||
        left.downloadBytes - right.downloadBytes ||
        left.index - right.index ||
        compareText(left.name, right.name),
    )
    .map((item) => item.index);
}

async function preflightFetchedPackage(
  fetched: FetchPackageResult,
  options: ResolvedPipelineOptions,
  signal: AbortSignal,
  adapters: CapabilityAnalysisAdapters,
): Promise<ManifestPreflightResult> {
  if (fetched.status === "unavailable") {
    return {
      status: "unavailable",
      changedPackage: fetched.changedPackage,
      failures: [{ stage: "fetch", failure: fetched.failure }],
    };
  }
  validateVerifiedBaseline(fetched.changedPackage, fetched.oldTarball);
  let extraction: ExtractionResult;
  try {
    extraction = await (adapters.extractManifestOnly ?? adapters.extract)(
      fetched.newTarball,
      {
        ...options.extractor,
        signal,
      },
    );
  } catch (error: unknown) {
    if (isAborted(signal)) {
      return preflightStopped(fetched.changedPackage, signal);
    }
    throw new CapabilityAnalysisPipelineError(
      `new manifest preflight extraction for ${JSON.stringify(fetched.changedPackage.name)} threw`,
      { cause: error },
    );
  }
  if (extraction.status === "rejected") {
    if (isAborted(signal)) {
      const stopKind = analysisStopKind(signal) ?? "analysis-aborted";
      const prior =
        extraction.failure.kind === stopKind
          ? []
          : [{ stage: "new-extraction" as const, failure: extraction.failure }];
      return preflightStopped(fetched.changedPackage, signal, prior);
    }
    return {
      status: "unavailable",
      changedPackage: fetched.changedPackage,
      failures: [{ stage: "new-extraction", failure: extraction.failure }],
    };
  }

  let manifest: ManifestCapabilityResult | undefined;
  let operationError: unknown;
  try {
    manifest = await adapters.extractManifest(
      extraction,
      subject(fetched.changedPackage, "new"),
      { ...options.manifestExtractor, signal },
    );
  } catch (error: unknown) {
    operationError = error;
  }
  const cleanupIssue = await cleanup("new", extraction);
  if (isAborted(signal)) {
    return preflightStopped(
      fetched.changedPackage,
      signal,
      cleanupIssue === null ? [] : [cleanupIssue],
    );
  }
  if (operationError !== undefined) {
    const cleanupContext =
      cleanupIssue === null
        ? ""
        : `; cleanup also failed (${cleanupIssue.failure.detail})`;
    throw new CapabilityAnalysisPipelineError(
      `new manifest preflight threw for ${JSON.stringify(fetched.changedPackage.name)}${cleanupContext}`,
      { cause: operationError },
    );
  }
  if (manifest === undefined) {
    throw new CapabilityAnalysisPipelineError(
      `new manifest preflight returned no result for ${JSON.stringify(fetched.changedPackage.name)}`,
    );
  }
  if (manifest.status === "unavailable") {
    const failures: [PackageAnalysisFailure, ...PackageAnalysisFailure[]] = [
      { stage: "new-manifest", failure: manifest.failure },
    ];
    if (cleanupIssue !== null) failures.push(cleanupIssue);
    return {
      status: "unavailable",
      changedPackage: fetched.changedPackage,
      failures,
    };
  }
  return {
    status: "ready",
    changedPackage: fetched.changedPackage,
    newManifest: manifest.set,
    hasInstallScript: manifest.set.capabilities.some(
      (capability) => capability.kind === "INSTALL_HOOK",
    ),
    issues: cleanupIssue === null ? [] : [cleanupIssue],
  };
}

function preflightStopped(
  changedPackage: ChangedPackage,
  signal: AbortSignal,
  priorFailures: readonly PackageAnalysisFailure[] = [],
): ManifestPreflightUnavailable {
  const stopped = stoppedSide(signal, priorFailures);
  return {
    status: "unavailable",
    changedPackage,
    failures: stopped.failures,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prioritizePreflightPackages(
  fetched: readonly FetchPackageResult[],
  lockfileDiff: LockfileDiffResult,
): number[] {
  const scoreByName = new Map<string, number>();
  for (const finding of lockfileDiff.findings) {
    const score = finding.kind === "integrity-changed-version-same" ? 100 : 80;
    scoreByName.set(
      finding.name,
      Math.max(scoreByName.get(finding.name) ?? 0, score),
    );
  }
  return fetched
    .map((item, index) => ({
      index,
      score:
        (item.changedPackage.oldVersion === null ? 90 : 0) +
        (scoreByName.get(item.changedPackage.name) ?? 0),
      downloadBytes:
        item.status === "verified"
          ? item.newTarball.bytes.length +
            (item.oldTarball === null ? 0 : item.oldTarball.bytes.length)
          : Number.MAX_SAFE_INTEGER,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.downloadBytes - right.downloadBytes ||
        left.index - right.index,
    )
    .map((item) => item.index);
}

function uniqueIssues(
  issues: readonly PackageAnalysisFailure[],
): PackageAnalysisFailure[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function analyzeFetchedPackage(
  fetched: FetchPackageResult,
  options: ResolvedPipelineOptions,
  signal: AbortSignal,
  adapters: CapabilityAnalysisAdapters,
  preflight: ManifestPreflightReady,
): Promise<PackageAnalysisResult> {
  if (fetched.status === "unavailable") {
    return {
      status: "unavailable",
      changedPackage: fetched.changedPackage,
      failures: [{ stage: "fetch", failure: fetched.failure }],
    };
  }

  const changedPackage = fetched.changedPackage;
  validateVerifiedBaseline(changedPackage, fetched.oldTarball);
  let oldSet: CapabilitySet | null = null;
  const issues: PackageAnalysisFailure[] = [...preflight.issues];
  if (fetched.oldTarball !== null) {
    const old = await analyzeSide(
      "old",
      fetched.oldTarball,
      subject(changedPackage, "old"),
      options,
      signal,
      adapters,
    );
    if (!old.ok) {
      return {
        status: "unavailable",
        changedPackage,
        failures: old.failures,
      };
    }
    oldSet = old.set;
    issues.push(...old.issues);
  }

  if (isAborted(signal)) {
    return policyUnavailable(changedPackage, signal, issues);
  }

  const newest = await analyzeSide(
    "new",
    fetched.newTarball,
    subject(changedPackage, "new"),
    options,
    signal,
    adapters,
    preflight.newManifest,
  );
  if (!newest.ok) {
    return {
      status: "unavailable",
      changedPackage,
      failures: prependFailures(issues, newest.failures),
    };
  }
  issues.push(...newest.issues);
  if (isAborted(signal)) {
    return policyUnavailable(changedPackage, signal, issues);
  }

  return {
    status: "analyzed",
    changedPackage,
    diff: applyCapabilityAllowlist(
      callSyncWithContext(
        `capability diff for ${JSON.stringify(changedPackage.name)}`,
        () => adapters.diff(oldSet, newest.set),
      ),
      options.config,
    ),
    issues: uniqueIssues(issues),
  };
}

function policyUnavailable(
  changedPackage: ChangedPackage,
  signal: AbortSignal,
  priorFailures: readonly PackageAnalysisFailure[] = [],
): UnavailablePackage {
  const failure = analysisFailure(signal);
  const failures = uniqueIssues([...priorFailures, failure]);
  const [first, ...rest] = failures;
  if (first === undefined) {
    throw new CapabilityAnalysisPipelineContractError(
      "policy failure construction produced no failure",
    );
  }
  return {
    status: "unavailable",
    changedPackage,
    failures: [first, ...rest],
  };
}

function analysisFailure(signal: AbortSignal): PackageAnalysisFailure {
  const kind: AnalysisStopKind = analysisStopKind(signal) ?? "analysis-aborted";
  return {
    stage: "analysis",
    failure: { kind, detail: analysisStopDetail(signal) },
  };
}

function stoppedSide(
  signal: AbortSignal,
  priorFailures: readonly PackageAnalysisFailure[] = [],
): SideAnalysisFailure {
  const failure = analysisFailure(signal);
  const [first, ...rest] = priorFailures;
  return {
    ok: false,
    failures: first === undefined ? [failure] : [first, ...rest, failure],
  };
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function prependFailures(
  prefix: readonly PackageAnalysisFailure[],
  failures: readonly [PackageAnalysisFailure, ...PackageAnalysisFailure[]],
): [PackageAnalysisFailure, ...PackageAnalysisFailure[]] {
  const [first, ...rest] = prefix;
  return first === undefined ? [...failures] : [first, ...rest, ...failures];
}

function validateVerifiedBaseline(
  changedPackage: ChangedPackage,
  oldTarball: VerifiedTarball | null,
): void {
  if ((changedPackage.oldVersion === null) !== (oldTarball === null)) {
    throw new CapabilityAnalysisPipelineContractError(
      `Fetcher baseline for ${JSON.stringify(changedPackage.name)} violates ADR-006`,
    );
  }
}

function subject(
  changedPackage: ChangedPackage,
  side: AnalysisSide,
): PackageSubject {
  const version =
    side === "old" ? changedPackage.oldVersion : changedPackage.newVersion;
  if (version === null) {
    throw new CapabilityAnalysisPipelineContractError(
      `old subject requested for newly added ${JSON.stringify(changedPackage.name)}`,
    );
  }
  return { ecosystem: "npm", name: changedPackage.name, version };
}

async function analyzeSide(
  side: AnalysisSide,
  tarball: VerifiedTarball,
  expected: PackageSubject,
  options: ResolvedPipelineOptions,
  signal: AbortSignal,
  adapters: CapabilityAnalysisAdapters,
  preflightedManifest?: CapabilitySet,
): Promise<SideAnalysisResult> {
  let extraction: ExtractionResult;
  try {
    extraction = await adapters.extract(tarball, {
      ...options.extractor,
      signal,
    });
  } catch (error: unknown) {
    if (isAborted(signal)) return stoppedSide(signal);
    throw new CapabilityAnalysisPipelineError(
      `${side} extraction for ${JSON.stringify(expected.name)} threw`,
      { cause: error },
    );
  }
  if (extraction.status === "rejected") {
    if (isAborted(signal)) {
      const stopKind = analysisStopKind(signal) ?? "analysis-aborted";
      return stoppedSide(
        signal,
        extraction.failure.kind === stopKind
          ? []
          : [{ stage: `${side}-extraction`, failure: extraction.failure }],
      );
    }
    return {
      ok: false,
      failures: [{ stage: `${side}-extraction`, failure: extraction.failure }],
    };
  }

  let manifest: ManifestCapabilityResult | undefined;
  let javascript: JavaScriptCapabilityLayerResult | undefined;
  let operationError: unknown;
  try {
    manifest =
      preflightedManifest === undefined
        ? await adapters.extractManifest(extraction, expected, {
            ...options.manifestExtractor,
            signal,
          })
        : { status: "analyzed", set: preflightedManifest };
    if (manifest.status === "analyzed") {
      javascript = await adapters.extractJavaScript(extraction, manifest.set, {
        ...options.astExtractor,
        signal,
      });
    }
  } catch (error: unknown) {
    operationError = error;
  }

  const cleanupIssue = await cleanup(side, extraction);
  if (isAborted(signal)) {
    return stoppedSide(signal, cleanupIssue === null ? [] : [cleanupIssue]);
  }
  if (operationError !== undefined) {
    const cleanupContext =
      cleanupIssue === null
        ? ""
        : `; cleanup also failed (${cleanupIssue.failure.detail})`;
    throw new CapabilityAnalysisPipelineError(
      `${side} manifest extraction threw for ${JSON.stringify(expected.name)}${cleanupContext}`,
      { cause: operationError },
    );
  }
  if (manifest === undefined) {
    throw new CapabilityAnalysisPipelineError(
      `${side} manifest extraction returned no result for ${JSON.stringify(expected.name)}`,
    );
  }
  if (manifest.status === "unavailable") {
    const failures: [PackageAnalysisFailure, ...PackageAnalysisFailure[]] = [
      { stage: `${side}-manifest`, failure: manifest.failure },
    ];
    if (cleanupIssue !== null) failures.push(cleanupIssue);
    return { ok: false, failures };
  }
  if (javascript === undefined) {
    throw new CapabilityAnalysisPipelineError(
      `${side} JavaScript extraction returned no result for ${JSON.stringify(expected.name)}`,
    );
  }
  return {
    ok: true,
    set: mergeJavaScriptCapabilityLayer(manifest.set, javascript),
    issues: cleanupIssue === null ? [] : [cleanupIssue],
  };
}

async function cleanup(
  side: AnalysisSide,
  extraction: ExtractedTarball,
): Promise<PackageAnalysisFailure | null> {
  try {
    await extraction.cleanup();
    return null;
  } catch (error: unknown) {
    return {
      stage: `${side}-cleanup`,
      failure: {
        kind: "cleanup-failed",
        detail: `cleanup failed: ${errorName(error)}`,
      },
    };
  }
}

async function callWithContext<T>(
  context: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw new CapabilityAnalysisPipelineError(`${context} threw`, {
      cause: error,
    });
  }
}

function callSyncWithContext<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    throw new CapabilityAnalysisPipelineError(`${context} threw`, {
      cause: error,
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** M1 compatibility aliases; new callers should use capability terminology. */
export type ManifestAnalysisRun = CapabilityAnalysisRun;
export type ManifestAnalysisOptions = CapabilityAnalysisOptions;
export {
  CapabilityAnalysisPipelineConfigurationError as ManifestAnalysisPipelineConfigurationError,
  CapabilityAnalysisPipelineContractError as ManifestAnalysisPipelineContractError,
  CapabilityAnalysisPipelineError as ManifestAnalysisPipelineError,
};
export const analyzeManifestPackages = analyzeChangedPackages;
export const createManifestAnalysisPipeline = createCapabilityAnalysisPipeline;
