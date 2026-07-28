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
  diffManifestCapabilities,
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

export interface ManifestAnalysisRun {
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

export interface ManifestAnalysisOptions {
  fetcher?: FetcherOptions;
  extractor?: ExtractorOptions;
  manifestExtractor?: ManifestCapabilityExtractorOptions;
  astExtractor?: AstExtractionOptions;
  /** PLAN §2 default: at most four packages extracting concurrently. */
  extractionConcurrency?: number;
}

export class ManifestAnalysisPipelineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ManifestAnalysisPipelineConfigurationError extends ManifestAnalysisPipelineError {}

export class ManifestAnalysisPipelineContractError extends ManifestAnalysisPipelineError {}

interface ManifestAnalysisAdapters {
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

const DEFAULT_EXTRACTION_CONCURRENCY = 4;

const DEFAULT_ADAPTERS: ManifestAnalysisAdapters = {
  fetch: fetchChangedPackages,
  extract: extractVerifiedTarball,
  extractManifest: extractNpmManifestCapabilities,
  extractJavaScript: extractNpmJavaScriptCapabilities,
  diff: diffManifestCapabilities,
};

/**
 * Fetches, safely extracts, and manifest-diffs every analyzable lockfile change.
 * Package-local failures are returned and processing continues (PLAN §2).
 */
export const analyzeManifestPackages =
  createManifestAnalysisPipeline(DEFAULT_ADAPTERS);

/** Internal construction seam used by inert orchestration tests. */
export function createManifestAnalysisPipeline(
  adapters: ManifestAnalysisAdapters,
): (
  lockfileDiff: LockfileDiffResult,
  options?: ManifestAnalysisOptions,
) => Promise<ManifestAnalysisRun> {
  return async (
    lockfileDiff: LockfileDiffResult,
    options: ManifestAnalysisOptions = {},
  ): Promise<ManifestAnalysisRun> => {
    const extractionConcurrency = resolveExtractionConcurrency(options);
    const fetched = await callWithContext("package fetch batch", () =>
      adapters.fetch(lockfileDiff.changed, options.fetcher ?? {}),
    );
    validateFetchResults(lockfileDiff.changed, fetched);

    const packages = new Array<PackageAnalysisResult>(fetched.length);
    let nextIndex = 0;
    const workerCount = Math.min(extractionConcurrency, fetched.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          const fetchedPackage = fetched[index];
          if (fetchedPackage === undefined) return;
          packages[index] = await analyzeFetchedPackage(
            fetchedPackage,
            options,
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
  };
}

function resolveExtractionConcurrency(
  options: ManifestAnalysisOptions,
): number {
  const value = options.extractionConcurrency ?? DEFAULT_EXTRACTION_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ManifestAnalysisPipelineConfigurationError(
      "extractionConcurrency must be a positive safe integer",
    );
  }
  return value;
}

function validateFetchResults(
  expected: readonly ChangedPackage[],
  actual: readonly FetchPackageResult[],
): void {
  if (actual.length !== expected.length) {
    throw new ManifestAnalysisPipelineContractError(
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
      throw new ManifestAnalysisPipelineContractError(
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
  options: ManifestAnalysisOptions,
  adapters: ManifestAnalysisAdapters,
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

  const newest = await analyzeSide(
    "new",
    fetched.newTarball,
    subject(changedPackage, "new"),
    options,
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
    throw new ManifestAnalysisPipelineContractError(
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
    throw new ManifestAnalysisPipelineContractError(
      `old subject requested for newly added ${JSON.stringify(changedPackage.name)}`,
    );
  }
  return { ecosystem: "npm", name: changedPackage.name, version };
}

async function analyzeSide(
  side: AnalysisSide,
  tarball: VerifiedTarball,
  expected: PackageSubject,
  options: ManifestAnalysisOptions,
  adapters: ManifestAnalysisAdapters,
): Promise<SideAnalysisResult> {
  const extraction = await callWithContext(
    `${side} extraction for ${JSON.stringify(expected.name)}`,
    () => adapters.extract(tarball, options.extractor ?? {}),
  );
  if (extraction.status === "rejected") {
    return {
      ok: false,
      failures: [{ stage: `${side}-extraction`, failure: extraction.failure }],
    };
  }

  let manifest: ManifestCapabilityResult | undefined;
  let javascript: JavaScriptCapabilityLayerResult | undefined;
  let operationError: unknown;
  try {
    manifest = await adapters.extractManifest(
      extraction,
      expected,
      options.manifestExtractor ?? {},
    );
    if (manifest.status === "analyzed") {
      javascript = await adapters.extractJavaScript(
        extraction,
        manifest.set,
        options.astExtractor ?? {},
      );
    }
  } catch (error: unknown) {
    operationError = error;
  }

  const cleanupIssue = await cleanup(side, extraction);
  if (operationError !== undefined) {
    const cleanupContext =
      cleanupIssue === null
        ? ""
        : `; cleanup also failed (${cleanupIssue.failure.detail})`;
    throw new ManifestAnalysisPipelineError(
      `${side} manifest extraction threw for ${JSON.stringify(expected.name)}${cleanupContext}`,
      { cause: operationError },
    );
  }
  if (manifest === undefined) {
    throw new ManifestAnalysisPipelineError(
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
    throw new ManifestAnalysisPipelineError(
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
    throw new ManifestAnalysisPipelineError(`${context} threw`, {
      cause: error,
    });
  }
}

function callSyncWithContext<T>(context: string, operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    throw new ManifestAnalysisPipelineError(`${context} threw`, {
      cause: error,
    });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
