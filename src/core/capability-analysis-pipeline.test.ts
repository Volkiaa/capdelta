import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CapabilitySet,
  PackageSubject,
} from "./contract/capability-set.js";
import type {
  ChangedPackage,
  LockfileDiffResult,
} from "./contract/lockfile-diff.js";
import type { CapabilityDiffResult } from "./capability-differ.js";
import type {
  FetchPackageResult,
  FetcherOptions,
  VerifiedTarball,
} from "./npm/fetcher.js";
import type {
  ExtractionResult,
  ExtractorOptions,
} from "./npm/safe-extractor.js";
import type {
  ManifestCapabilityExtractorOptions,
  ManifestCapabilityResult,
} from "./npm/manifest-capability-extractor.js";
import type {
  AstExtractionOptions,
  JavaScriptCapabilityLayerResult,
} from "./npm/javascript-capability-extractor.js";
import {
  CapabilityAnalysisPipelineError,
  CapabilityAnalysisPipelineConfigurationError,
  CapabilityAnalysisPipelineContractError,
  analyzeChangedPackages,
  createCapabilityAnalysisPipeline,
} from "./capability-analysis-pipeline.js";
import {
  ManifestAnalysisPipelineConfigurationError,
  ManifestAnalysisPipelineContractError,
  ManifestAnalysisPipelineError,
  analyzeManifestPackages,
  createManifestAnalysisPipeline,
} from "./manifest-analysis-pipeline.js";
import type { CapdeltaConfig } from "./capdelta-config.js";
import { buildRunReport } from "./reporter.js";
import {
  evaluateSeverityGate,
  hasOperationalFailure,
  operationalFailureCount,
} from "./run-severity.js";

const TARBALL: VerifiedTarball = {
  integrity: "sha512-inert",
  bytes: new Uint8Array([1]),
};

function changedPackage(
  name: string,
  oldVersion: string | null = null,
): ChangedPackage {
  return {
    name,
    oldVersion,
    newVersion: "2.0.0",
    oldIntegrity: oldVersion === null ? null : "sha512-old",
    newIntegrity: "sha512-new",
    oldResolvedUrl:
      oldVersion === null ? null : `https://registry.npmjs.org/${name}/old.tgz`,
    resolvedUrl: `https://registry.npmjs.org/${name}/new.tgz`,
  };
}

function lockfileDiff(packages: readonly ChangedPackage[]): LockfileDiffResult {
  return {
    changed: [...packages],
    findings: [],
    skipped: [],
    firstRun: false,
  };
}

function capabilitySet(subject: PackageSubject): CapabilitySet {
  return {
    schemaVersion: 1,
    subject,
    completeness: "complete",
    capabilities: [],
    diagnostics: [],
  };
}

function capabilityDiff(
  oldSet: CapabilitySet | null,
  newSet: CapabilitySet,
): CapabilityDiffResult {
  return {
    baseline: oldSet?.subject ?? null,
    subject: newSet.subject,
    newPackage: oldSet === null,
    findings: [],
    diagnostics: [],
  };
}

interface AdapterOverrides {
  fetch?: (
    packages: readonly ChangedPackage[],
    options: FetcherOptions,
  ) => Promise<FetchPackageResult[]>;
  extract?: (
    tarball: VerifiedTarball,
    options: ExtractorOptions,
  ) => Promise<ExtractionResult>;
  extractManifest?: (
    expected: PackageSubject,
    options: ManifestCapabilityExtractorOptions,
  ) => Promise<ManifestCapabilityResult>;
  extractJavaScript?: (
    options: AstExtractionOptions,
  ) => Promise<JavaScriptCapabilityLayerResult>;
  diff?: (
    oldSet: CapabilitySet | null,
    newSet: CapabilitySet,
  ) => CapabilityDiffResult;
}

function pipeline(overrides: AdapterOverrides = {}) {
  return createCapabilityAnalysisPipeline({
    fetch: (packages, options) =>
      overrides.fetch?.(packages, options) ??
      Promise.resolve(
        packages.map((changedPackage) => ({
          status: "verified" as const,
          changedPackage,
          oldTarball: changedPackage.oldVersion === null ? null : TARBALL,
          newTarball: TARBALL,
        })),
      ),
    extract: (tarball, options) =>
      overrides.extract?.(tarball, options) ??
      Promise.resolve({
        status: "extracted" as const,
        root: "C:\\inert-fixture",
        fileCount: 1,
        expandedBytes: 1,
        cleanup: () => Promise.resolve(),
      }),
    extractManifest: (_extracted, expected, options) =>
      overrides.extractManifest?.(expected, options) ??
      Promise.resolve({ status: "analyzed", set: capabilitySet(expected) }),
    extractJavaScript: (_extracted, _manifestSet, options) =>
      overrides.extractJavaScript?.(options) ??
      Promise.resolve({ capabilities: [], diagnostics: [] }),
    diff: overrides.diff ?? capabilityDiff,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("analyzeChangedPackages", () => {
  it("retains the M1 public aliases", () => {
    expect(analyzeManifestPackages).toBe(analyzeChangedPackages);
    expect(createManifestAnalysisPipeline).toBe(
      createCapabilityAnalysisPipeline,
    );
    expect(ManifestAnalysisPipelineError).toBe(CapabilityAnalysisPipelineError);
    expect(ManifestAnalysisPipelineConfigurationError).toBe(
      CapabilityAnalysisPipelineConfigurationError,
    );
    expect(ManifestAnalysisPipelineContractError).toBe(
      CapabilityAnalysisPipelineContractError,
    );
    expect([
      new ManifestAnalysisPipelineError("legacy").name,
      new ManifestAnalysisPipelineConfigurationError("legacy").name,
      new ManifestAnalysisPipelineContractError("legacy").name,
    ]).toEqual([
      "ManifestAnalysisPipelineError",
      "ManifestAnalysisPipelineConfigurationError",
      "ManifestAnalysisPipelineContractError",
    ]);
  });

  it("analyzes old and new manifests, preserves order, and returns run counts", async () => {
    const packages = [
      changedPackage("updated", "1.0.0"),
      changedPackage("new"),
    ];

    const result = await pipeline()(lockfileDiff(packages));

    expect(result.summary).toEqual({
      changed: 2,
      analyzed: 2,
      unavailable: 0,
      skipped: 0,
    });
    expect(result.packages.map((item) => item.changedPackage.name)).toEqual([
      "updated",
      "new",
    ]);
    expect(result.packages.every((item) => item.status === "analyzed")).toBe(
      true,
    );
    const updated = result.packages[0];
    const added = result.packages[1];
    expect(updated?.status === "analyzed" && updated.diff.newPackage).toBe(
      false,
    );
    expect(added?.status === "analyzed" && added.diff.newPackage).toBe(true);
  });

  it("continues after a fetch failure and preserves its typed stage", async () => {
    const failed = changedPackage("failed");
    const good = changedPackage("good");
    const run = pipeline({
      fetch: (packages) =>
        Promise.resolve([
          {
            status: "unavailable",
            changedPackage: packages[0] ?? failed,
            failure: {
              side: "new",
              kind: "http-status",
              detail: "HTTP 404",
              url: failed.resolvedUrl,
            },
          },
          {
            status: "verified",
            changedPackage: packages[1] ?? good,
            oldTarball: null,
            newTarball: TARBALL,
          },
        ]),
    });

    const result = await run(lockfileDiff([failed, good]));

    expect(result.summary).toMatchObject({ analyzed: 1, unavailable: 1 });
    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "fetch", failure: { kind: "http-status" } }],
    });
    expect(result.packages[1]?.status).toBe("analyzed");
  });

  it("reports an exhausted transient fetch as an operational failure (ADR-018)", async () => {
    const run = pipeline({
      fetch: (packages) => {
        const target = packages[0];
        if (target === undefined) throw new Error("missing fixture package");
        return Promise.resolve([
          {
            status: "unavailable" as const,
            changedPackage: target,
            failure: {
              side: "new" as const,
              kind: "network-error" as const,
              detail: "connection reset",
              url: target.resolvedUrl,
            },
          },
        ]);
      },
    });

    const result = await run(lockfileDiff([changedPackage("flaky")]));

    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "fetch", failure: { kind: "network-error" } }],
    });
    expect(hasOperationalFailure(result)).toBe(true);
    expect(operationalFailureCount(result)).toBe(1);
  });

  it("does not report a deterministic fetch failure as operational (ADR-018)", async () => {
    const run = pipeline({
      fetch: (packages) => {
        const target = packages[0];
        if (target === undefined) throw new Error("missing fixture package");
        return Promise.resolve([
          {
            status: "unavailable" as const,
            changedPackage: target,
            failure: {
              side: "new" as const,
              kind: "http-status" as const,
              detail: "HTTP 404",
              url: target.resolvedUrl,
            },
          },
        ]);
      },
    });

    const result = await run(lockfileDiff([changedPackage("missing")]));

    expect(hasOperationalFailure(result)).toBe(false);
    expect(operationalFailureCount(result)).toBe(0);
  });

  it("keeps the run-level stop when cancellation lands before the fetch result is processed (ADR-018)", async () => {
    const controller = new AbortController();
    let markFetched: (() => void) | undefined;
    const fetched = new Promise<void>((resolve) => {
      markFetched = resolve;
    });
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const run = pipeline({
      fetch: async (packages) => {
        markFetched?.();
        await gate;
        const target = packages[0];
        if (target === undefined) throw new Error("missing fixture package");
        return [
          {
            status: "unavailable" as const,
            changedPackage: target,
            failure: {
              side: "new" as const,
              kind: "http-unavailable" as const,
              detail: "HTTP 503",
              url: target.resolvedUrl,
            },
          },
        ];
      },
    });

    const pending = run(lockfileDiff([changedPackage("slow")]), {
      execution: { signal: controller.signal },
    });
    await fetched;
    controller.abort();
    releaseFetch?.();
    const result = await pending;

    // The transient fetch failure is superseded by the run-level stop, but the
    // stop itself is operational, so the package still counts.
    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "analysis", failure: { kind: "analysis-aborted" } }],
    });
    expect(hasOperationalFailure(result)).toBe(true);
  });

  it("returns extraction and manifest failures and still cleans extracted roots", async () => {
    let cleanupCalls = 0;
    const extractionFailure = pipeline({
      extract: () =>
        Promise.resolve({
          status: "rejected",
          failure: { kind: "unsafe-path", detail: "parent traversal" },
        }),
    });
    const rejected = await extractionFailure(
      lockfileDiff([changedPackage("rejected")]),
    );
    expect(rejected.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "new-extraction", failure: { kind: "unsafe-path" } }],
    });

    const manifestFailure = createCapabilityAnalysisPipeline({
      fetch: (packages) =>
        Promise.resolve([
          {
            status: "verified",
            changedPackage: packages[0] ?? changedPackage("manifest"),
            oldTarball: null,
            newTarball: TARBALL,
          },
        ]),
      extract: () =>
        Promise.resolve({
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => {
            cleanupCalls += 1;
            return Promise.resolve();
          },
        }),
      extractManifest: () =>
        Promise.resolve({
          status: "unavailable",
          failure: {
            kind: "manifest-invalid-json",
            detail: "invalid JSON",
            evidence: null,
          },
        }),
      extractJavaScript: () =>
        Promise.resolve({ capabilities: [], diagnostics: [] }),
      diff: capabilityDiff,
    });
    const unavailable = await manifestFailure(
      lockfileDiff([changedPackage("manifest")]),
    );
    expect(unavailable.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "new-manifest" }],
    });
    expect(cleanupCalls).toBe(1);
  });

  it("reports cleanup failure without discarding a completed analysis", async () => {
    const run = pipeline({
      extract: () =>
        Promise.resolve({
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => Promise.reject(new Error("locked")),
        }),
    });

    const result = await run(lockfileDiff([changedPackage("cleanup")]));

    expect(result.packages[0]).toMatchObject({
      status: "analyzed",
      issues: [
        {
          stage: "new-cleanup",
          failure: { kind: "cleanup-failed", detail: "cleanup failed: Error" },
        },
      ],
    });
  });

  it("reports preflight cleanup when the new manifest is unavailable", async () => {
    let extraction = 0;
    const run = pipeline({
      extract: () => {
        extraction += 1;
        return Promise.resolve({
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () =>
            extraction === 1
              ? Promise.reject(new Error("old locked"))
              : Promise.resolve(),
        });
      },
      extractManifest: (expected) =>
        expected.version === "1.0.0"
          ? Promise.resolve({
              status: "analyzed",
              set: capabilitySet(expected),
            })
          : Promise.resolve({
              status: "unavailable",
              failure: {
                kind: "manifest-missing",
                detail: "package.json is missing",
                evidence: null,
              },
            }),
    });

    const result = await run(
      lockfileDiff([changedPackage("old-cleanup-new-failure", "1.0.0")]),
    );

    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "new-manifest" }, { stage: "new-cleanup" }],
    });
  });

  it("reports cleanup context when manifest extraction throws", async () => {
    const run = pipeline({
      extract: () =>
        Promise.resolve({
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => Promise.reject(new Error("locked")),
        }),
      extractManifest: () => Promise.reject(new TypeError("adapter bug")),
    });

    await expect(
      run(lockfileDiff([changedPackage("throwing-adapter")])),
    ).rejects.toThrow(/cleanup also failed \(cleanup failed: Error\)/u);
  });

  it("adds context to unexpected fetcher and differ throws", async () => {
    const fetchError = new TypeError("fetch adapter bug");
    await expect(
      pipeline({ fetch: () => Promise.reject(fetchError) })(lockfileDiff([])),
    ).rejects.toMatchObject({
      name: "ManifestAnalysisPipelineError",
      message: "package fetch batch threw",
      cause: fetchError,
    });

    const diffError = new RangeError("differ adapter bug");
    await expect(
      pipeline({
        diff: () => {
          throw diffError;
        },
      })(lockfileDiff([changedPackage("differ-throw")])),
    ).rejects.toMatchObject({
      name: "ManifestAnalysisPipelineError",
      message: 'capability diff for "differ-throw" threw',
      cause: diffError,
    });
  });

  it("enforces extraction concurrency while preserving package order", async () => {
    let active = 0;
    let maximumActive = 0;
    const run = pipeline({
      extract: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => Promise.resolve(),
        };
      },
    });
    const packages = Array.from({ length: 6 }, (_, index) =>
      changedPackage(`package-${String(index)}`),
    );

    const result = await run(lockfileDiff(packages), {
      extractionConcurrency: 2,
    });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(result.packages.map((item) => item.changedPackage.name)).toEqual(
      packages.map((item) => item.name),
    );
  });

  it("starts higher-risk packages first but preserves report order", async () => {
    const extractionOrder: string[] = [];
    const run = pipeline({
      extractManifest: (expected) => {
        extractionOrder.push(expected.name);
        return Promise.resolve({
          status: "analyzed" as const,
          set: capabilitySet(expected),
        });
      },
    });
    const packages = [
      changedPackage("routine", "1.0.0"),
      changedPackage("new"),
    ];
    const result = await run(
      {
        ...lockfileDiff(packages),
        findings: [
          {
            kind: "version-downgrade",
            name: "routine",
            path: "node_modules/routine",
            oldVersion: "1.0.0",
            newVersion: "2.0.0",
          },
        ],
      },
      { extractionConcurrency: 1 },
    );
    expect(extractionOrder).toEqual(["new", "routine", "routine"]);
    expect(result.packages.map((item) => item.changedPackage.name)).toEqual([
      "routine",
      "new",
    ]);
    expect(result.budget).toMatchObject({
      prioritization: "install-script-first",
      startedPackages: 2,
      completedPackages: 2,
      unstartedPackages: 0,
      partial: false,
    });
  });

  it("prioritizes manifest install hooks before smaller downloads", async () => {
    const analysisOrder: string[] = [];
    const routine = changedPackage("routine", "1.0.0");
    const small = changedPackage("small");
    const run = pipeline({
      extractManifest: (expected) =>
        Promise.resolve({
          status: "analyzed" as const,
          set:
            expected.name === "routine"
              ? {
                  ...capabilitySet(expected),
                  capabilities: [
                    {
                      kind: "INSTALL_HOOK" as const,
                      location: {
                        kind: "install-script" as const,
                        hook: "postinstall" as const,
                        applicability: "registry-install" as const,
                      },
                      contentDigest: {
                        algorithm: "sha256" as const,
                        value: "0".repeat(64),
                      },
                      evidence: [
                        { file: "package.json", line: 1, snippet: "inert" },
                      ],
                    },
                  ],
                }
              : capabilitySet(expected),
        }),
      diff: (oldSet, newSet) => {
        analysisOrder.push(newSet.subject.name);
        return capabilityDiff(oldSet, newSet);
      },
    });

    const result = await run(lockfileDiff([routine, small]), {
      extractionConcurrency: 1,
    });

    expect(analysisOrder).toEqual(["routine", "small"]);
    expect(result.budget?.prioritization).toBe("install-script-first");
  });

  it("projects one execution policy into every analysis stage", async () => {
    const observed: {
      fetch?: FetcherOptions;
      extraction?: ExtractorOptions;
      manifest?: ManifestCapabilityExtractorOptions;
      javascript?: AstExtractionOptions;
    } = {};
    const run = pipeline({
      fetch: (packages, options) => {
        observed.fetch = options;
        return Promise.resolve(
          packages.map((changedPackage) => ({
            status: "verified" as const,
            changedPackage,
            oldTarball: null,
            newTarball: TARBALL,
          })),
        );
      },
      extract: (_tarball, options) => {
        observed.extraction = options;
        return Promise.resolve({
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => Promise.resolve(),
        });
      },
      extractManifest: (expected, options) => {
        observed.manifest = options;
        return Promise.resolve({
          status: "analyzed",
          set: capabilitySet(expected),
        });
      },
      extractJavaScript: (options) => {
        observed.javascript = options;
        return Promise.resolve({ capabilities: [], diagnostics: [] });
      },
    });

    await run(lockfileDiff([changedPackage("policy")]), {
      execution: {
        deadlineMs: 10_000,
        fetch: { concurrency: 2, timeoutMs: 11, maxTarballBytes: 12 },
        extraction: {
          concurrency: 1,
          maxFileCount: 13,
          maxExpandedBytes: 14,
          maxDecompressionRatio: 15,
        },
        manifest: { maxBytes: 16 },
        javascript: { maxSourceBytes: 17, parseTimeoutMs: 18 },
      },
    });

    expect(observed.fetch).toMatchObject({
      concurrency: 2,
      timeoutMs: 11,
      maxTarballBytes: 12,
    });
    expect(observed.fetch?.signal).toBeInstanceOf(AbortSignal);
    expect(observed.extraction).toMatchObject({
      maxFileCount: 13,
      maxExpandedBytes: 14,
      maxDecompressionRatio: 15,
    });
    expect(observed.extraction?.signal).toBeInstanceOf(AbortSignal);
    expect(observed.manifest).toMatchObject({ maxManifestBytes: 16 });
    expect(observed.manifest?.signal).toBeInstanceOf(AbortSignal);
    expect(observed.javascript).toMatchObject({
      maxSourceBytes: 17,
      parseTimeoutMs: 18,
    });
    expect(observed.javascript?.signal).toBeInstanceOf(AbortSignal);
  });

  it("flags work not started after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    let extractions = 0;
    const result = await pipeline({
      extract: () => {
        extractions += 1;
        throw new Error("must not extract after cancellation");
      },
    })(lockfileDiff([changedPackage("one"), changedPackage("two")]), {
      execution: { signal: controller.signal },
    });

    expect(extractions).toBe(0);
    expect(result.summary).toMatchObject({ analyzed: 0, unavailable: 2 });
    expect(
      result.packages.map((item) =>
        item.status === "unavailable" ? item.failures[0] : null,
      ),
    ).toEqual([
      {
        stage: "analysis",
        failure: {
          kind: "analysis-aborted",
          detail: "analysis aborted by caller",
        },
      },
      {
        stage: "analysis",
        failure: {
          kind: "analysis-aborted",
          detail: "analysis aborted by caller",
        },
      },
    ]);
    expect(result.budget).toMatchObject({
      startedPackages: 0,
      completedPackages: 2,
      unstartedPackages: 2,
      deadlineExceeded: false,
      partial: true,
    });
  });

  it("cleans active safe work and flags all unfinished work at the deadline", async () => {
    vi.useFakeTimers();
    let releaseExtraction: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    let cleanups = 0;
    const pending = pipeline({
      extract: async () => {
        markStarted?.();
        await gate;
        return {
          status: "extracted",
          root: "C:\\inert-fixture",
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => {
            cleanups += 1;
            return Promise.resolve();
          },
        };
      },
    })(lockfileDiff([changedPackage("active"), changedPackage("queued")]), {
      execution: { deadlineMs: 10, extraction: { concurrency: 1 } },
    });

    await started;
    vi.advanceTimersByTime(10);
    releaseExtraction?.();
    const result = await pending;

    expect(cleanups).toBe(1);
    expect(
      result.packages.map((item) =>
        item.status === "unavailable" ? item.failures.at(-1) : null,
      ),
    ).toEqual([
      {
        stage: "analysis",
        failure: {
          kind: "deadline-exceeded",
          detail: "analysis wall-clock deadline exceeded",
        },
      },
      {
        stage: "analysis",
        failure: {
          kind: "deadline-exceeded",
          detail: "analysis wall-clock deadline exceeded",
        },
      },
    ]);
    expect(result.budget).toMatchObject({
      startedPackages: 1,
      completedPackages: 2,
      unstartedPackages: 1,
      deadlineExceeded: true,
      partial: true,
    });
  });

  it("preserves an extractor cleanup failure alongside cancellation", async () => {
    vi.useFakeTimers();
    let releaseExtraction: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const pending = pipeline({
      extract: async () => {
        markStarted?.();
        await gate;
        return {
          status: "rejected",
          failure: {
            kind: "filesystem-error",
            detail: "extraction failed and cleanup failed",
          },
        };
      },
    })(lockfileDiff([changedPackage("cleanup")]), {
      execution: { deadlineMs: 10 },
    });

    await started;
    vi.advanceTimersByTime(10);
    releaseExtraction?.();
    const result = await pending;

    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [
        {
          stage: "new-extraction",
          failure: { kind: "filesystem-error" },
        },
        {
          stage: "analysis",
          failure: { kind: "deadline-exceeded" },
        },
      ],
    });
  });

  it("deduplicates an extractor stop reason from the run-level failure", async () => {
    vi.useFakeTimers();
    let releaseExtraction: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const pending = pipeline({
      extract: async () => {
        markStarted?.();
        await gate;
        return {
          status: "rejected",
          failure: {
            kind: "deadline-exceeded",
            detail: "analysis wall-clock deadline exceeded",
          },
        };
      },
    })(lockfileDiff([changedPackage("deduplicated")]), {
      execution: { deadlineMs: 10 },
    });

    await started;
    vi.advanceTimersByTime(10);
    releaseExtraction?.();
    const result = await pending;

    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [
        {
          stage: "analysis",
          failure: { kind: "deadline-exceeded" },
        },
      ],
    });
  });

  it("keeps an excepted old-side extraction failure gating when the new side is clean (amendment C.2)", async () => {
    const oldTarball: VerifiedTarball = {
      integrity: "sha512-old",
      bytes: new Uint8Array([1]),
    };
    const newTarball: VerifiedTarball = {
      integrity: "sha512-new",
      bytes: new Uint8Array([2]),
    };
    const run = createCapabilityAnalysisPipeline({
      fetch: (packages) =>
        Promise.resolve(
          packages.map((changedPackage) => ({
            status: "verified" as const,
            changedPackage,
            oldTarball,
            newTarball,
          })),
        ),
      extract: (tarball) =>
        tarball.integrity === "sha512-old"
          ? Promise.resolve({
              status: "rejected" as const,
              failure: {
                kind: "invalid-archive" as const,
                detail: "old broken",
              },
            })
          : Promise.resolve({
              status: "extracted" as const,
              root: "C:\\inert-fixture",
              fileCount: 1,
              expandedBytes: 1,
              cleanup: () => Promise.resolve(),
            }),
      extractManifest: (_extracted, expected) =>
        Promise.resolve({
          status: "analyzed" as const,
          set: capabilitySet(expected),
        }),
      extractJavaScript: () =>
        Promise.resolve({ capabilities: [], diagnostics: [] }),
      diff: capabilityDiff,
    });
    const config: CapdeltaConfig = {
      allowlist: [],
      unanalyzable: [
        {
          package: "old-fails",
          version: "1.0.0",
          integrity: "sha512-old",
          kind: "invalid-archive",
          justification: "reviewed old artifact",
        },
      ],
    };
    const result = await run(
      lockfileDiff([changedPackage("old-fails", "1.0.0")]),
      {
        config,
      },
    );
    const item = result.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.failures).toMatchObject([
      { stage: "old-extraction", failure: { kind: "invalid-archive" } },
    ]);
    // The old-side exception cannot release the package: no new-side failure
    // was inspected and bound.
    expect(item.exception).toBeUndefined();
    expect(evaluateSeverityGate(buildRunReport(result), "CRITICAL").fail).toBe(
      true,
    );
  });

  it("extracts the new side after an old-side failure and cleans both directories", async () => {
    const cleanups: string[] = [];
    const oldTarball: VerifiedTarball = {
      integrity: "sha512-old",
      bytes: new Uint8Array([1]),
    };
    const newTarball: VerifiedTarball = {
      integrity: "sha512-new",
      bytes: new Uint8Array([2]),
    };
    const run = createCapabilityAnalysisPipeline({
      fetch: (packages) =>
        Promise.resolve(
          packages.map((changedPackage) => ({
            status: "verified" as const,
            changedPackage,
            oldTarball,
            newTarball,
          })),
        ),
      extractManifestOnly: (tarball) =>
        Promise.resolve({
          status: "extracted" as const,
          root: `manifest-${tarball.integrity}`,
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => {
            cleanups.push(`manifest:${tarball.integrity}`);
            return Promise.resolve();
          },
        }),
      extract: (tarball) =>
        Promise.resolve({
          status: "extracted" as const,
          root: `full-${tarball.integrity}`,
          fileCount: 1,
          expandedBytes: 1,
          cleanup: () => {
            cleanups.push(`full:${tarball.integrity}`);
            return Promise.resolve();
          },
        }),
      extractManifest: (_extracted, expected) =>
        expected.version === "1.0.0"
          ? Promise.resolve({
              status: "unavailable" as const,
              failure: {
                kind: "manifest-missing" as const,
                detail: "package.json is missing",
                evidence: null,
              },
            })
          : Promise.resolve({
              status: "analyzed" as const,
              set: capabilitySet(expected),
            }),
      extractJavaScript: () =>
        Promise.resolve({ capabilities: [], diagnostics: [] }),
      diff: capabilityDiff,
    });
    const result = await run(
      lockfileDiff([changedPackage("old-manifest-fails", "1.0.0")]),
    );
    expect(result.packages[0]).toMatchObject({
      status: "unavailable",
      failures: [{ stage: "old-manifest" }],
    });
    // Both full extraction roots were created and cleaned: the old side before
    // its manifest failure, and the new side that the amendment now reaches.
    expect(cleanups).toEqual(
      expect.arrayContaining(["full:sha512-old", "full:sha512-new"]),
    );
  });

  it("propagates lockfile facts and validates configuration and adapter contracts", async () => {
    const diff = lockfileDiff([]);
    diff.firstRun = true;
    diff.findings.push({
      kind: "version-downgrade",
      name: "fixture",
      path: "node_modules/fixture",
      oldVersion: "2.0.0",
      newVersion: "1.0.0",
    });
    diff.skipped.push({
      name: "private",
      path: "node_modules/private",
      reason: "private-registry",
      detail: "private host",
    });

    const result = await pipeline()(diff);
    expect(result).toMatchObject({
      firstRun: true,
      summary: { skipped: 1 },
      lockfileFindings: [{ kind: "version-downgrade" }],
      skipped: [{ reason: "private-registry" }],
    });
    await expect(
      pipeline()(lockfileDiff([]), { extractionConcurrency: 0 }),
    ).rejects.toBeInstanceOf(CapabilityAnalysisPipelineConfigurationError);
    await expect(
      pipeline()(lockfileDiff([]), {
        extractionConcurrency: 2,
        execution: { extraction: { concurrency: 2 } },
      }),
    ).rejects.toThrow(/configured in both/u);

    const broken = pipeline({ fetch: () => Promise.resolve([]) });
    await expect(
      broken(lockfileDiff([changedPackage("missing-result")])),
    ).rejects.toBeInstanceOf(CapabilityAnalysisPipelineContractError);
  });
});
