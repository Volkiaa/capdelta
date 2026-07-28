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
}

export interface CapabilityAnalysisOptions {
  execution?: AnalysisExecutionPolicy;
  fetcher?: FetcherOptions;
  extractor?: ExtractorOptions;
  manifestExtractor?: ManifestCapabilityExtractorOptions;
  astExtractor?: AstExtractionOptions;
  /** PLAN §2 default: at most four packages extracting concurrently. */
  extractionConcurrency?: number;
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

type SideAnalysisResult = SideAnalysisSuccess | SideAnalysisFailure;

const DEFAULT_ADAPTERS: CapabilityAnalysisAdapters = {
  fetch: fetchChangedPackages,
  extract: extractVerifiedTarball,
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

      const packages = new Array<PackageAnalysisResult>(fetched.length);
      let nextIndex = 0;
      const workerCount = Math.min(
        resolved.execution.extraction.concurrency,
        fetched.length,
      );
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            const fetchedPackage = fetched[index];
            if (fetchedPackage === undefined) return;
            packages[index] = control.signal.aborted
              ? policyUnavailable(fetchedPackage.changedPackage, control.signal)
              : await analyzeFetchedPackage(
                  fetchedPackage,
                  resolved,
                  control.signal,
                  adapters,
                );
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

async function analyzeFetchedPackage(
  fetched: FetchPackageResult,
  options: ResolvedPipelineOptions,
  signal: AbortSignal,
  adapters: CapabilityAnalysisAdapters,
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
  const issues: PackageAnalysisFailure[] = [];
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
    diff: callSyncWithContext(
      `capability diff for ${JSON.stringify(changedPackage.name)}`,
      () => adapters.diff(oldSet, newest.set),
    ),
    issues,
  };
}

function policyUnavailable(
  changedPackage: ChangedPackage,
  signal: AbortSignal,
  priorFailures: readonly PackageAnalysisFailure[] = [],
): UnavailablePackage {
  const failure = analysisFailure(signal);
  const [first, ...rest] = priorFailures;
  const failures: [PackageAnalysisFailure, ...PackageAnalysisFailure[]] =
    first === undefined ? [failure] : [first, ...rest, failure];
  return {
    status: "unavailable",
    changedPackage,
    failures,
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
    if (isAborted(signal)) return stoppedSide(signal);
    return {
      ok: false,
      failures: [{ stage: `${side}-extraction`, failure: extraction.failure }],
    };
  }

  let manifest: ManifestCapabilityResult | undefined;
  let javascript: JavaScriptCapabilityLayerResult | undefined;
  let operationError: unknown;
  try {
    manifest = await adapters.extractManifest(extraction, expected, {
      ...options.manifestExtractor,
      signal,
    });
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
