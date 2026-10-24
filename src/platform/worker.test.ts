import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_VALUE_CHARS } from "../core/report-builder.js";
import { JobQueue } from "./job-queue.js";
import { JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import { drainQueue, type WorkerEvent } from "./worker.js";

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
    expect(events).toEqual([{ kind: "done", id: jobs[0]?.id, created: true }]);
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
    expect(events).toEqual([
      {
        kind: "retry",
        id: jobs[0]?.id,
        attempt: 1,
        error: "transient",
      },
      { kind: "done", id: jobs[0]?.id, created: false },
    ]);
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
});
