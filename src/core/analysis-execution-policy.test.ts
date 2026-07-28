import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalysisExecutionPolicyConfigurationError,
  analysisStopDetail,
  resolveAnalysisExecutionPolicy,
  startAnalysisRun,
} from "./analysis-execution-policy.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("analysis execution policy", () => {
  it("resolves the PLAN defaults and explicit nested limits", () => {
    const defaults = resolveAnalysisExecutionPolicy();
    expect(defaults).toMatchObject({
      deadlineMs: 300_000,
      fetch: { concurrency: 8, maxTarballBytes: 50 * 1024 * 1024 },
      extraction: { concurrency: 4, maxExpandedBytes: 250 * 1024 * 1024 },
      manifest: { maxBytes: 1024 * 1024 },
      javascript: { maxSourceBytes: 2 * 1024 * 1024 },
    });

    expect(
      resolveAnalysisExecutionPolicy({
        deadlineMs: 10,
        fetch: { concurrency: 2 },
        extraction: { maxFileCount: 3 },
      }),
    ).toMatchObject({
      deadlineMs: 10,
      fetch: { concurrency: 2 },
      extraction: { maxFileCount: 3 },
    });
  });

  it.each([
    { deadlineMs: 0 },
    { fetch: { concurrency: -1 } },
    { extraction: { maxDecompressionRatio: 1.5 } },
    { javascript: { parseTimeoutMs: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects an invalid security limit %#", (policy) => {
    expect(() => resolveAnalysisExecutionPolicy(policy)).toThrow(
      AnalysisExecutionPolicyConfigurationError,
    );
  });

  it("distinguishes caller cancellation from the wall-clock deadline", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const callerRun = startAnalysisRun(
      resolveAnalysisExecutionPolicy({
        deadlineMs: 100,
        signal: caller.signal,
      }),
    );
    caller.abort(new Error("untrusted caller reason"));
    expect(callerRun.stopKind()).toBe("analysis-aborted");
    expect(analysisStopDetail(callerRun.signal)).toBe(
      "analysis aborted by caller",
    );
    callerRun.dispose();

    const deadlineRun = startAnalysisRun(
      resolveAnalysisExecutionPolicy({ deadlineMs: 100 }),
    );
    vi.advanceTimersByTime(100);
    expect(deadlineRun.stopKind()).toBe("deadline-exceeded");
    expect(analysisStopDetail(deadlineRun.signal)).toBe(
      "analysis wall-clock deadline exceeded",
    );
    deadlineRun.dispose();
  });
});
