export interface AnalysisExecutionPolicy {
  /** PLAN §2 approximate whole-run wall-clock budget. */
  deadlineMs?: number;
  /** Optional caller cancellation, observed cooperatively between safe stages. */
  signal?: AbortSignal;
  fetch?: {
    concurrency?: number;
    timeoutMs?: number;
    maxTarballBytes?: number;
  };
  extraction?: {
    concurrency?: number;
    maxFileCount?: number;
    maxExpandedBytes?: number;
    maxDecompressionRatio?: number;
  };
  manifest?: {
    maxBytes?: number;
  };
  javascript?: {
    maxSourceBytes?: number;
    parseTimeoutMs?: number;
  };
}

export interface ResolvedAnalysisExecutionPolicy {
  deadlineMs: number;
  signal?: AbortSignal;
  fetch: {
    concurrency: number;
    timeoutMs: number;
    maxTarballBytes: number;
  };
  extraction: {
    concurrency: number;
    maxFileCount: number;
    maxExpandedBytes: number;
    maxDecompressionRatio: number;
  };
  manifest: {
    maxBytes: number;
  };
  javascript: {
    maxSourceBytes: number;
    parseTimeoutMs: number;
  };
}

export type AnalysisStopKind = "deadline-exceeded" | "analysis-aborted";

export interface AnalysisRunControl {
  signal: AbortSignal;
  stopKind(): AnalysisStopKind | null;
  dispose(): void;
}

export class AnalysisExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AnalysisExecutionPolicyConfigurationError extends AnalysisExecutionPolicyError {}

const DEFAULT_POLICY: ResolvedAnalysisExecutionPolicy = {
  deadlineMs: 5 * 60_000,
  fetch: {
    concurrency: 8,
    timeoutMs: 30_000,
    maxTarballBytes: 50 * 1024 * 1024,
  },
  extraction: {
    concurrency: 4,
    maxFileCount: 10_000,
    maxExpandedBytes: 250 * 1024 * 1024,
    maxDecompressionRatio: 100,
  },
  manifest: { maxBytes: 1024 * 1024 },
  javascript: {
    maxSourceBytes: 2 * 1024 * 1024,
    parseTimeoutMs: 5_000,
  },
};

const DEADLINE_ABORT = Symbol("capdelta analysis deadline");
const CALLER_ABORT = Symbol("capdelta caller abort");

export function resolveAnalysisExecutionPolicy(
  policy: AnalysisExecutionPolicy = {},
): ResolvedAnalysisExecutionPolicy {
  const resolved: ResolvedAnalysisExecutionPolicy = {
    deadlineMs: policy.deadlineMs ?? DEFAULT_POLICY.deadlineMs,
    fetch: {
      concurrency:
        policy.fetch?.concurrency ?? DEFAULT_POLICY.fetch.concurrency,
      timeoutMs: policy.fetch?.timeoutMs ?? DEFAULT_POLICY.fetch.timeoutMs,
      maxTarballBytes:
        policy.fetch?.maxTarballBytes ?? DEFAULT_POLICY.fetch.maxTarballBytes,
    },
    extraction: {
      concurrency:
        policy.extraction?.concurrency ?? DEFAULT_POLICY.extraction.concurrency,
      maxFileCount:
        policy.extraction?.maxFileCount ??
        DEFAULT_POLICY.extraction.maxFileCount,
      maxExpandedBytes:
        policy.extraction?.maxExpandedBytes ??
        DEFAULT_POLICY.extraction.maxExpandedBytes,
      maxDecompressionRatio:
        policy.extraction?.maxDecompressionRatio ??
        DEFAULT_POLICY.extraction.maxDecompressionRatio,
    },
    manifest: {
      maxBytes: policy.manifest?.maxBytes ?? DEFAULT_POLICY.manifest.maxBytes,
    },
    javascript: {
      maxSourceBytes:
        policy.javascript?.maxSourceBytes ??
        DEFAULT_POLICY.javascript.maxSourceBytes,
      parseTimeoutMs:
        policy.javascript?.parseTimeoutMs ??
        DEFAULT_POLICY.javascript.parseTimeoutMs,
    },
    ...(policy.signal === undefined ? {} : { signal: policy.signal }),
  };

  for (const [name, value] of numericPolicyEntries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AnalysisExecutionPolicyConfigurationError(
        `${name} must be a positive safe integer`,
      );
    }
  }
  if (policy.signal !== undefined && !isAbortSignal(policy.signal)) {
    throw new AnalysisExecutionPolicyConfigurationError(
      "signal must implement AbortSignal",
    );
  }
  return resolved;
}

export function startAnalysisRun(
  policy: ResolvedAnalysisExecutionPolicy,
): AnalysisRunControl {
  const controller = new AbortController();
  const caller = policy.signal;
  const abortFromCaller = (): void => {
    if (!controller.signal.aborted) controller.abort(CALLER_ABORT);
  };
  if (caller?.aborted === true) abortFromCaller();
  else caller?.addEventListener("abort", abortFromCaller, { once: true });

  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(DEADLINE_ABORT);
  }, policy.deadlineMs);
  deadline.unref();

  return {
    signal: controller.signal,
    stopKind: () => analysisStopKind(controller.signal),
    dispose: () => {
      clearTimeout(deadline);
      caller?.removeEventListener("abort", abortFromCaller);
    },
  };
}

export function analysisStopKind(signal: AbortSignal): AnalysisStopKind | null {
  if (!signal.aborted) return null;
  return signal.reason === DEADLINE_ABORT
    ? "deadline-exceeded"
    : "analysis-aborted";
}

export function analysisStopDetail(signal: AbortSignal): string {
  return analysisStopKind(signal) === "deadline-exceeded"
    ? "analysis wall-clock deadline exceeded"
    : "analysis aborted by caller";
}

function numericPolicyEntries(
  policy: ResolvedAnalysisExecutionPolicy,
): readonly (readonly [string, number])[] {
  return [
    ["deadlineMs", policy.deadlineMs],
    ["fetch.concurrency", policy.fetch.concurrency],
    ["fetch.timeoutMs", policy.fetch.timeoutMs],
    ["fetch.maxTarballBytes", policy.fetch.maxTarballBytes],
    ["extraction.concurrency", policy.extraction.concurrency],
    ["extraction.maxFileCount", policy.extraction.maxFileCount],
    ["extraction.maxExpandedBytes", policy.extraction.maxExpandedBytes],
    [
      "extraction.maxDecompressionRatio",
      policy.extraction.maxDecompressionRatio,
    ],
    ["manifest.maxBytes", policy.manifest.maxBytes],
    ["javascript.maxSourceBytes", policy.javascript.maxSourceBytes],
    ["javascript.parseTimeoutMs", policy.javascript.parseTimeoutMs],
  ];
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}
