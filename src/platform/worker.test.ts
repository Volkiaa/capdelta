import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VALUE_CHARS } from "../core/report-builder.js";
import { JobQueue } from "./job-queue.js";
import { JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import { drainQueue, WorkerError, type WorkerEvent } from "./worker.js";

let base: string;
let queue: JobQueue;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-worker-"));
  queue = new JobQueue(new JsonStore({ root: join(base, "root") }), () => {
    return new Date("2026-01-01T00:00:00.000Z");
  });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function candidate(name: string): ReleaseCandidate {
  return {
    ecosystem: "npm",
    name,
    version: "1.0.0",
    digest: `sha512-${name}`,
    tarballUrl: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    previous: null,
    publishedAt: "2025-12-31T00:00:00.000Z",
  };
}

describe("drainQueue", () => {
  it("analyzes a pending job and marks it done", async () => {
    await queue.enqueue(candidate("alpha"));
    const events: WorkerEvent[] = [];

    const counts = await drainQueue({
      queue,
      analyze: () => Promise.resolve({ created: true }),
      onEvent: (event) => events.push(event),
    });

    expect(counts).toEqual({ done: 1, retried: 0, failed: 0 });
    const jobs = await queue.list();
    expect(jobs[0]).toMatchObject({ state: "done", attempts: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "done",
      id: jobs[0]?.id,
      name: "alpha",
      version: "1.0.0",
      created: true,
    });
    const done = events[0];
    if (done?.kind !== "done") throw new Error("expected a done event");
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty queue with zero counts", async () => {
    const counts = await drainQueue({
      queue,
      analyze: () => Promise.resolve({ created: false }),
    });

    expect(counts).toEqual({ done: 0, retried: 0, failed: 0 });
  });

  it("retries a thrown analysis once and finishes the job", async () => {
    await queue.enqueue(candidate("alpha"));
    const events: WorkerEvent[] = [];
    let calls = 0;

    const counts = await drainQueue({
      queue,
      analyze: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ created: false });
      },
      onEvent: (event) => events.push(event),
    });

    expect(counts).toEqual({ done: 1, retried: 1, failed: 0 });
    const jobs = await queue.list();
    expect(jobs[0]).toMatchObject({ state: "done", attempts: 2 });
    expect(events).toMatchObject([
      {
        kind: "retry",
        id: jobs[0]?.id,
        attempt: 1,
        error: "transient",
      },
      {
        kind: "done",
        id: jobs[0]?.id,
        name: "alpha",
        version: "1.0.0",
        created: false,
      },
    ]);
    const done = events[1];
    if (done?.kind !== "done") throw new Error("expected a done event");
    expect(done.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("fails a job after maxAttempts and stops draining", async () => {
    await queue.enqueue(candidate("alpha"));
    const events: WorkerEvent[] = [];
    const message = "boom ".repeat(2_000);

    const counts = await drainQueue({
      queue,
      analyze: () => Promise.reject(new Error(message)),
      maxAttempts: 3,
      onEvent: (event) => events.push(event),
    });

    expect(counts).toEqual({ done: 0, retried: 2, failed: 1 });
    const jobs = await queue.list();
    expect(jobs[0]).toMatchObject({ state: "failed", attempts: 3 });
    expect(jobs[0]?.lastError).toHaveLength(MAX_VALUE_CHARS);
    expect(jobs[0]?.lastError?.endsWith("\u2026")).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      "retry",
      "retry",
      "failed",
    ]);
    const last = events[2];
    expect(last?.kind === "failed" ? last.error.length : 0).toBe(
      MAX_VALUE_CHARS,
    );
  });

  it("uses three attempts by default", async () => {
    await queue.enqueue(candidate("alpha"));

    const counts = await drainQueue({
      queue,
      analyze: () => Promise.reject(new Error("always")),
    });

    expect(counts).toEqual({ done: 0, retried: 2, failed: 1 });
    const jobs = await queue.list();
    expect(jobs[0]).toMatchObject({ state: "failed", attempts: 3 });
  });

  it.each([0, 17, 1.5, Number.NaN])(
    "rejects concurrency %s",
    async (concurrency) => {
      await expect(
        drainQueue({
          queue,
          analyze: () => Promise.resolve({ created: false }),
          concurrency,
        }),
      ).rejects.toBeInstanceOf(WorkerError);
    },
  );

  it("runs at most three analyses at once and analyzes every job once", async () => {
    const names = Array.from(
      { length: 12 },
      (_, index) => `pkg-${String(index)}`,
    );
    for (const name of names) await queue.enqueue(candidate(name));

    const pending: (() => void)[] = [];
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    const drained = drainQueue({
      queue,
      concurrency: 3,
      analyze: (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(item.name);
        return new Promise((resolve) => {
          pending.push(() => {
            inFlight -= 1;
            completed += 1;
            resolve({ created: true });
          });
        });
      },
    });

    await vi.waitFor(() => {
      expect(pending).toHaveLength(3);
    });

    while (completed < names.length) {
      const release = pending.shift();
      if (release === undefined) {
        await vi.waitFor(() => {
          expect(pending.length).toBeGreaterThan(0);
        });
        continue;
      }
      release();
      if (completed < names.length) {
        await vi.waitFor(() => {
          expect(pending.length).toBeGreaterThan(0);
        });
      }
    }

    const counts = await drained;

    expect(maxInFlight).toBe(3);
    expect(started).toHaveLength(names.length);
    expect(new Set(started)).toEqual(new Set(names));
    expect(counts).toEqual({ done: 12, retried: 0, failed: 0 });
    await expect(queue.list("done")).resolves.toHaveLength(12);
  });

  it("analyzes in claim order with the default concurrency", async () => {
    const names = Array.from(
      { length: 5 },
      (_, index) => `serial-${String(index)}`,
    );
    for (const name of names) await queue.enqueue(candidate(name));
    const claimOrder = (await queue.list()).map((job) => job.candidate.name);
    const started: string[] = [];

    await drainQueue({
      queue,
      analyze: (item) => {
        started.push(item.name);
        return Promise.resolve({ created: true });
      },
    });

    expect(started).toEqual(claimOrder);
  });

  it("finishes the other jobs when one job fails every attempt", async () => {
    for (const name of ["bad", "good-1", "good-2", "good-3"]) {
      await queue.enqueue(candidate(name));
    }

    const counts = await drainQueue({
      queue,
      concurrency: 3,
      maxAttempts: 2,
      analyze: (item) =>
        item.name === "bad"
          ? Promise.reject(new Error("broken"))
          : Promise.resolve({ created: true }),
    });

    expect(counts).toEqual({ done: 3, retried: 1, failed: 1 });
    const jobs = await queue.list();
    const bad = jobs.find((job) => job.candidate.name === "bad");
    expect(bad).toMatchObject({ state: "failed", attempts: 2 });
    expect(jobs.filter((job) => job.state === "done")).toHaveLength(3);
  });

  it("reports the time from claim to completion", async () => {
    await queue.enqueue(candidate("alpha"));
    const events: WorkerEvent[] = [];

    await drainQueue({
      queue,
      analyze: async () => {
        await delay(20);
        return { created: true };
      },
      onEvent: (event) => events.push(event),
    });

    const done = events[0];
    if (done?.kind !== "done") throw new Error("expected a done event");
    expect(done.elapsedMs).toBeGreaterThanOrEqual(10);
    expect(done.elapsedMs).toBeLessThan(1_000);
  });

  it("rejects after in-flight jobs finish when a claim fails", async () => {
    class FailingJobStore extends JsonStore {
      jobReads = 0;

      override async get(kind: string, key: string): Promise<unknown> {
        if (kind === "job") {
          this.jobReads += 1;
          if (this.jobReads === 3) throw new Error("store unavailable");
        }
        return super.get(kind, key);
      }
    }

    const failingQueue = new JobQueue(
      new FailingJobStore({ root: join(base, "failing") }),
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    for (const name of ["first", "second", "third"]) {
      await failingQueue.enqueue(candidate(name));
    }

    const pending: (() => void)[] = [];
    const started: string[] = [];
    let settled = false;
    const drained = drainQueue({
      queue: failingQueue,
      concurrency: 3,
      analyze: (item) => {
        started.push(item.name);
        return new Promise((resolve) => {
          pending.push(() => {
            resolve({ created: true });
          });
        });
      },
    });
    void drained.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => {
      expect(started).toHaveLength(2);
      expect(settled).toBe(false);
    });
    for (const release of pending) release();

    await expect(drained).rejects.toThrow("store unavailable");
    const jobs = await failingQueue.list();
    expect(jobs.filter((job) => job.state === "done")).toHaveLength(2);
    expect(jobs.filter((job) => job.state === "pending")).toHaveLength(1);
  });
});
