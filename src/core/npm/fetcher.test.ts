import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangedPackage } from "../contract/lockfile-diff.js";
import {
  resolveAnalysisExecutionPolicy,
  startAnalysisRun,
} from "../analysis-execution-policy.js";
import {
  FetcherConfigurationError,
  FetcherContractError,
  MemoryTarballCache,
  fetchChangedPackages,
} from "./fetcher.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function wasAborted(signal: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

function integrityFor(value: Uint8Array): string {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

// ADR-018
const instantSleep = (): Promise<void> => Promise.resolve();

function changedPackage(
  overrides: Partial<ChangedPackage> = {},
): ChangedPackage {
  const old = bytes(1, 2, 3);
  const newest = bytes(4, 5, 6);
  return {
    name: "fixture-package",
    oldVersion: "1.0.0",
    newVersion: "2.0.0",
    oldIntegrity: integrityFor(old),
    newIntegrity: integrityFor(newest),
    oldResolvedUrl: "https://registry.npmjs.org/fixture-package/-/old.tgz",
    resolvedUrl: "https://registry.npmjs.org/fixture-package/-/new.tgz",
    ...overrides,
  };
}

describe("fetchChangedPackages", () => {
  it("downloads, verifies, and returns old and new inert bytes", async () => {
    const old = bytes(1, 2, 3);
    const newest = bytes(4, 5, 6);
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(new Response(calls === 1 ? old : newest));
    };

    const results = await fetchChangedPackages([changedPackage()], {
      fetchImpl,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "verified" });
    const result = results[0];
    if (result?.status !== "verified")
      throw new Error("expected verified result");
    if (result.oldTarball === null) throw new Error("expected old tarball");
    expect(result.oldTarball.bytes).toEqual(old);
    expect(result.newTarball.bytes).toEqual(newest);
    expect(calls).toBe(2);
  });

  it("fetches only the new tarball for a newly-added package", async () => {
    const newest = bytes(4, 5, 6);
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response(newest));
        },
      },
    );

    const result = results[0];
    expect(result?.status).toBe("verified");
    if (result?.status !== "verified")
      throw new Error("expected verified result");
    expect(result.oldTarball).toBeNull();
    expect(result.newTarball.bytes).toEqual(newest);
    expect(calls).toBe(1);
  });

  it("returns a loud integrity-mismatch failure and never returns unverified bytes", async () => {
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      { fetchImpl: () => Promise.resolve(new Response(bytes(99))) },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { side: "new", kind: "integrity-mismatch" },
    });
  });

  it("rejects unsupported SRI before making a network request", async () => {
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
          newIntegrity: "sha256-not-accepted",
        }),
      ],
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response(bytes(4, 5, 6)));
        },
      },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "unsupported-integrity" },
    });
    expect(calls).toBe(0);
  });

  it("reports non-success HTTP responses and performs no retry", async () => {
    let calls = 0;
    let requestSignal: AbortSignal | null = null;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        fetchImpl: (_input, init) => {
          calls += 1;
          requestSignal = init?.signal ?? null;
          return Promise.resolve(new Response("not found", { status: 404 }));
        },
      },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "http-status" },
    });
    expect(calls).toBe(1);
    expect(wasAborted(requestSignal)).toBe(true);
  });

  it("retries a transient network failure with bounded backoff (ADR-018)", async () => {
    const newest = bytes(4, 5, 6);
    const backoffs: number[] = [];
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        fetchImpl: () => {
          calls += 1;
          return calls < 3
            ? Promise.reject(new TypeError("fetch failed"))
            : Promise.resolve(new Response(newest));
        },
        sleep: (ms) => {
          backoffs.push(ms);
          return Promise.resolve();
        },
      },
    );

    expect(results[0]?.status).toBe("verified");
    expect(calls).toBe(3);
    expect(backoffs).toEqual([250, 1_000]);
  });

  it("reports a network error only after the final attempt (ADR-018)", async () => {
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(new TypeError("fetch failed"));
        },
        sleep: instantSleep,
      },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "network-error" },
    });
    expect(calls).toBe(3);
  });

  it.each([408, 429, 500, 503])(
    "retries HTTP %s then succeeds (ADR-018)",
    async (status) => {
      const newest = bytes(4, 5, 6);
      let calls = 0;
      const results = await fetchChangedPackages(
        [
          changedPackage({
            oldVersion: null,
            oldIntegrity: null,
            oldResolvedUrl: null,
          }),
        ],
        {
          fetchImpl: () => {
            calls += 1;
            return calls === 1
              ? Promise.resolve(new Response("retry me", { status }))
              : Promise.resolve(new Response(newest));
          },
          sleep: instantSleep,
        },
      );

      expect(results[0]?.status).toBe("verified");
      expect(calls).toBe(2);
    },
  );

  it("reports a retryable status as http-unavailable after the last attempt (ADR-018)", async () => {
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        },
        sleep: instantSleep,
      },
    );

    expect(calls).toBe(3);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "http-unavailable" },
    });
    const result = results[0];
    if (result?.status !== "unavailable")
      throw new Error("expected unavailable result");
    expect(result.failure.detail).toContain("503");
  });

  it("counts a network failure followed by an abort during backoff as aborted (ADR-018)", async () => {
    const controller = new AbortController();
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        signal: controller.signal,
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(new TypeError("fetch failed"));
        },
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
      },
    );

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "aborted", detail: "analysis aborted by caller" },
    });
  });

  it("stops retrying when the deadline expires before the final attempt (ADR-018)", async () => {
    const controller = new AbortController();
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        signal: controller.signal,
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(new TypeError("fetch failed"));
        },
        sleep: () => {
          if (calls >= 2) controller.abort();
          return Promise.resolve();
        },
      },
    );

    expect(calls).toBe(2);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "aborted" },
    });
  });

  it("reports a stalled response aborted by the real run deadline (ADR-018)", async () => {
    vi.useFakeTimers();
    const control = startAnalysisRun(
      resolveAnalysisExecutionPolicy({ deadlineMs: 25 }),
    );
    let calls = 0;
    const pending = fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        signal: control.signal,
        timeoutMs: 60_000,
        fetchImpl: (_input, init) => {
          calls += 1;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        },
      },
    );

    vi.advanceTimersByTime(25);
    const results = await pending;
    control.dispose();

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: {
        kind: "aborted",
        detail: "analysis wall-clock deadline exceeded",
      },
    });
  });

  it("caps each attempt's timeout at the time remaining in the run (ADR-018)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const pending = fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        timeoutMs: 60_000,
        deadlineAt: Date.now() + 30,
        sleep: instantSleep,
        fetchImpl: (_input, init) => {
          calls += 1;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        },
      },
    );

    await vi.advanceTimersByTimeAsync(30);
    const results = await pending;

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "aborted" },
    });
  });

  it("cancels a failed response body before the next attempt (ADR-018)", async () => {
    const newest = bytes(4, 5, 6);
    let calls = 0;
    let cancelled = 0;
    const order: string[] = [];
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        fetchImpl: (_input, init) => {
          calls += 1;
          order.push(`fetch-${String(calls)}`);
          if (calls > 1) return Promise.resolve(new Response(newest));
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes(1));
            },
            cancel() {
              cancelled += 1;
              order.push("cancel");
            },
          });
          const response = new Response(body, { status: 503 });
          // A real fetch cancels the aborted body; model that contract here.
          init?.signal?.addEventListener(
            "abort",
            () => {
              void response.body?.cancel();
            },
            { once: true },
          );
          return Promise.resolve(response);
        },
        sleep: instantSleep,
      },
    );

    expect(results[0]?.status).toBe("verified");
    expect(calls).toBe(2);
    expect(cancelled).toBe(1);
    expect(order).toEqual(["fetch-1", "cancel", "fetch-2"]);
  });

  it("aborts the real backoff when the run signal aborts (ADR-018)", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        signal: controller.signal,
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(new TypeError("fetch failed"));
        },
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const results = await pending;

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "aborted", detail: "analysis aborted by caller" },
    });
  });

  it("removes the backoff abort listener after a normal completion (ADR-018)", async () => {
    vi.useFakeTimers();
    const addSpy = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removeSpy = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        signal: controller.signal,
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(new TypeError("fetch failed"));
        },
      },
    );

    await vi.advanceTimersByTimeAsync(1_500);
    const results = await pending;

    expect(calls).toBe(3);
    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "network-error" },
    });
    const abortAdds = addSpy.mock.calls.filter(
      ([type]) => type === "abort",
    ).length;
    const abortRemoves = removeSpy.mock.calls.filter(
      ([type]) => type === "abort",
    ).length;
    expect(abortRemoves).toBe(abortAdds);
    expect(abortAdds).toBeGreaterThan(0);
  });

  it("reports a timeout as a package-local failure", async () => {
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        timeoutMs: 1,
        fetchImpl: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("timed out", "AbortError"));
            });
          }),
        sleep: instantSleep,
      },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "timeout" },
    });
  });

  it("aborts in-flight work and flags packages that were not started", async () => {
    const controller = new AbortController();
    let calls = 0;
    const packages = ["first", "second"].map((name) =>
      changedPackage({
        name,
        oldVersion: null,
        oldIntegrity: null,
        oldResolvedUrl: null,
        resolvedUrl: `https://registry.npmjs.org/${name}/-/${name}.tgz`,
      }),
    );
    const pending = fetchChangedPackages(packages, {
      concurrency: 1,
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    });

    controller.abort();
    const results = await pending;

    expect(calls).toBe(1);
    expect(
      results.map((result) =>
        result.status === "unavailable" ? result.failure.kind : "verified",
      ),
    ).toEqual(["aborted", "aborted"]);
    expect(results[1]).toMatchObject({
      failure: { detail: "analysis aborted by caller" },
    });
  });

  it("rejects an oversized declared response before reading its body", async () => {
    let requestSignal: AbortSignal | null = null;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        maxTarballBytes: 3,
        fetchImpl: (_input, init) => {
          requestSignal = init?.signal ?? null;
          return Promise.resolve(
            new Response(bytes(4, 5, 6, 7), {
              headers: { "content-length": "4" },
            }),
          );
        },
      },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "size-limit-exceeded" },
    });
    expect(wasAborted(requestSignal)).toBe(true);
  });

  it("enforces the size cap while streaming when Content-Length is absent", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(4, 5));
        controller.enqueue(bytes(6, 7));
        controller.close();
      },
    });
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
        }),
      ],
      {
        maxTarballBytes: 3,
        fetchImpl: () => Promise.resolve(new Response(body)),
      },
    );

    expect(results[0]).toMatchObject({
      status: "unavailable",
      failure: { kind: "size-limit-exceeded" },
    });
  });

  it("re-verifies cache bytes and replaces a corrupt cache entry from the network", async () => {
    const newest = bytes(4, 5, 6);
    const integrity = integrityFor(newest);
    const cache = new MemoryTarballCache();
    cache.set(integrity, bytes(99));
    let calls = 0;

    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldVersion: null,
          oldIntegrity: null,
          oldResolvedUrl: null,
          newIntegrity: integrity,
        }),
      ],
      {
        cache,
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response(newest));
        },
      },
    );

    expect(results[0]?.status).toBe("verified");
    expect(calls).toBe(1);
  });

  it("reuses a verified integrity-keyed cache entry within one package", async () => {
    const artifact = bytes(8, 9, 10);
    const integrity = integrityFor(artifact);
    let calls = 0;
    const results = await fetchChangedPackages(
      [
        changedPackage({
          oldIntegrity: integrity,
          newIntegrity: integrity,
          oldResolvedUrl:
            "https://registry.npmjs.org/fixture-package/-/same.tgz",
          resolvedUrl: "https://registry.npmjs.org/fixture-package/-/same.tgz",
        }),
      ],
      {
        fetchImpl: () => {
          calls += 1;
          return Promise.resolve(new Response(artifact));
        },
      },
    );

    expect(results[0]?.status).toBe("verified");
    expect(calls).toBe(1);
  });

  it("limits concurrent package downloads to the configured cap", async () => {
    const artifact = bytes(4, 5, 6);
    let active = 0;
    let maximumActive = 0;
    const packages = Array.from({ length: 10 }, (_, index) =>
      changedPackage({
        name: `fixture-${String(index)}`,
        oldVersion: null,
        oldIntegrity: null,
        oldResolvedUrl: null,
        resolvedUrl: `https://registry.npmjs.org/fixture-${String(index)}/-/fixture.tgz`,
      }),
    );

    const results = await fetchChangedPackages(packages, {
      concurrency: 3,
      fetchImpl: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response(artifact);
      },
    });

    expect(results.every((result) => result.status === "verified")).toBe(true);
    expect(maximumActive).toBeLessThanOrEqual(3);
  });

  it("throws for invalid options and broken ADR-006 old-side contracts", async () => {
    await expect(
      fetchChangedPackages([], { maxTarballBytes: 0 }),
    ).rejects.toBeInstanceOf(FetcherConfigurationError);
    await expect(
      fetchChangedPackages([], { deadlineAt: 0 }),
    ).rejects.toBeInstanceOf(FetcherConfigurationError);
    await expect(
      fetchChangedPackages([
        changedPackage({ oldIntegrity: null, oldResolvedUrl: null }),
      ]),
    ).rejects.toBeInstanceOf(FetcherContractError);
  });
});
