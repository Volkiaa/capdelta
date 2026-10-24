import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeKey, JsonStore } from "./json-store.js";
import { JobQueue, JobQueueError } from "./job-queue.js";
import { MAX_VALUE_CHARS } from "../core/report-builder.js";
import type { ReleaseCandidate } from "./release-candidate.js";

let base: string;
let store: JsonStore;
let queue: JobQueue;
let now: Date;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-job-queue-"));
  store = new JsonStore({ root: join(base, "root") });
  now = new Date("2026-01-01T00:00:00.000Z");
  queue = new JobQueue(store, () => now);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function candidate(name: string, version = "1.0.0"): ReleaseCandidate {
  return {
    ecosystem: "npm",
    name,
    version,
    digest: `sha512-${name}-${version}`,
    tarballUrl: `https://registry.npmjs.org/${name}/-/${version}.tgz`,
    previous: null,
    publishedAt: "2025-12-31T00:00:00.000Z",
  };
}

function tick(milliseconds = 1000): void {
  now = new Date(now.getTime() + milliseconds);
}

describe("JobQueue.enqueue", () => {
  it("creates one job for a candidate enqueued twice", async () => {
    const release = candidate("alpha");

    await expect(queue.enqueue(release)).resolves.toBe(true);
    await expect(queue.enqueue(release)).resolves.toBe(false);

    const jobs = await queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(encodeKey("alpha\n1.0.0\nsha512-alpha-1.0.0"));
    expect(jobs[0]?.candidate).toEqual(release);
  });

  it("creates a second job when the digest differs", async () => {
    const first = candidate("alpha");
    const second = { ...first, digest: "sha512-other" };

    await expect(queue.enqueue(first)).resolves.toBe(true);
    await expect(queue.enqueue(second)).resolves.toBe(true);

    await expect(queue.list()).resolves.toHaveLength(2);
  });
});

describe("JobQueue.claim", () => {
  it("claims the oldest pending job first", async () => {
    await queue.enqueue(candidate("beta"));
    tick();
    await queue.enqueue(candidate("alpha"));

    const first = await queue.claim();
    expect(first?.candidate.name).toBe("beta");
    expect(first?.state).toBe("running");
    expect(first?.attempts).toBe(1);

    const second = await queue.claim();
    expect(second?.candidate.name).toBe("alpha");
    await expect(queue.claim()).resolves.toBeNull();
  });

  it("never claims a job that is done or failed", async () => {
    await queue.enqueue(candidate("done-job"));
    await queue.enqueue(candidate("failed-job"));

    const finished = await queue.claim();
    if (finished === null) throw new Error("expected a job");
    await queue.complete(finished.id);

    const doomed = await queue.claim();
    if (doomed === null) throw new Error("expected a job");
    await expect(queue.fail(doomed.id, "no", 1)).resolves.toBe("failed");

    await expect(queue.claim()).resolves.toBeNull();
    await expect(queue.get(finished.id)).resolves.toMatchObject({
      state: "done",
    });
  });
});

describe("JobQueue.fail", () => {
  it("returns a job to pending while attempts remain", async () => {
    await queue.enqueue(candidate("alpha"));
    const claimed = await queue.claim();
    if (claimed === null) throw new Error("expected a job");
    tick();

    await expect(queue.fail(claimed.id, "boom", 3)).resolves.toBe("pending");

    const after = await queue.get(claimed.id);
    expect(after?.state).toBe("pending");
    expect(after?.attempts).toBe(1);
    expect(after?.enqueuedAt).toBe(claimed.enqueuedAt);
    expect(after?.lastError).toBe("boom");
    expect(after?.updatedAt).not.toBe(claimed.updatedAt);
  });

  it("marks the job failed once attempts reach the limit", async () => {
    await queue.enqueue(candidate("alpha"));
    const claimed = await queue.claim();
    if (claimed === null) throw new Error("expected a job");

    await expect(queue.fail(claimed.id, "boom", 1)).resolves.toBe("failed");
    await expect(queue.get(claimed.id)).resolves.toMatchObject({
      state: "failed",
      attempts: 1,
    });
  });

  it("bounds the stored error to one value", async () => {
    await queue.enqueue(candidate("alpha"));
    const claimed = await queue.claim();
    if (claimed === null) throw new Error("expected a job");

    await queue.fail(claimed.id, "x".repeat(10_000), 1);

    const stored = await queue.get(claimed.id);
    expect(stored?.lastError).toHaveLength(MAX_VALUE_CHARS);
    expect(stored?.lastError?.endsWith("\u2026")).toBe(true);
  });
});

describe("JobQueue errors", () => {
  it("names the id when the job is missing", async () => {
    const id = encodeKey("absent\n1.0.0\nsha512-absent");

    await expect(queue.complete(id)).rejects.toBeInstanceOf(JobQueueError);
    await expect(queue.complete(id)).rejects.toThrow(id);
    await expect(queue.fail(id, "no", 1)).rejects.toThrow(id);
    await expect(queue.get(id)).resolves.toBeNull();
  });
});

describe("JobQueue.recover", () => {
  it("returns a crashed running job to pending, which then completes", async () => {
    await queue.enqueue(candidate("alpha"));
    const crashed = await queue.claim();
    if (crashed === null) throw new Error("expected a job");
    expect(crashed.state).toBe("running");

    await expect(queue.recover()).resolves.toBe(1);

    const recovered = await queue.get(crashed.id);
    expect(recovered?.state).toBe("pending");
    expect(recovered?.attempts).toBe(1);

    const claimedAgain = await queue.claim();
    expect(claimedAgain?.id).toBe(crashed.id);
    expect(claimedAgain?.attempts).toBe(2);
    if (claimedAgain === null) throw new Error("expected a job");
    await queue.complete(claimedAgain.id);
    await expect(queue.get(crashed.id)).resolves.toMatchObject({
      state: "done",
    });
  });

  it("leaves pending and finished jobs alone", async () => {
    await queue.enqueue(candidate("done-job"));
    const finished = await queue.claim();
    if (finished === null) throw new Error("expected a job");
    await queue.complete(finished.id);
    await queue.enqueue(candidate("pending-job"));

    await expect(queue.recover()).resolves.toBe(0);
  });
});

describe("JobQueue concurrent claims", () => {
  it("never returns the same job to two callers", async () => {
    await queue.enqueue(candidate("alpha"));
    await queue.enqueue(candidate("beta"));

    const [left, right] = await Promise.all([queue.claim(), queue.claim()]);

    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left?.id).not.toBe(right?.id);
    await expect(queue.claim()).resolves.toBeNull();
  });
});

describe("JobQueue read validation", () => {
  it("rejects a malformed record and names its id", async () => {
    const id = encodeKey("broken\n1.0.0\nsha512-broken");
    await store.put("job", id, {
      schemaVersion: 1,
      id,
      candidate: candidate("broken"),
      state: "sideways",
      attempts: 0,
      lastError: null,
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(queue.get(id)).rejects.toBeInstanceOf(JobQueueError);
    await expect(queue.get(id)).rejects.toThrow(id);
    await expect(queue.list()).rejects.toThrow(id);
  });
});
