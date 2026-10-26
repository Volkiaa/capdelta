import { NamedError } from "../core/named-error.js";
import { MAX_VALUE_CHARS, truncate } from "../core/report-builder.js";
import type { JobQueue, JobRecord } from "./job-queue.js";
import type { ReleaseCandidate } from "./release-candidate.js";

export interface WorkerOptions {
  queue: JobQueue;
  /** Wraps analyzeRelease in the caller. */
  analyze: (candidate: ReleaseCandidate) => Promise<{ created: boolean }>;
  /** Default 3. */
  maxAttempts?: number;
  /** Claim loops to run at once. Default 1, at most 16. */
  concurrency?: number;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | {
      kind: "done";
      id: string;
      name: string;
      version: string;
      created: boolean;
      elapsedMs: number;
    }
  | { kind: "retry"; id: string; attempt: number; error: string }
  | { kind: "failed"; id: string; error: string };

export class WorkerError extends NamedError {}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;

/** Processes jobs until the queue has no pending job. */
export async function drainQueue(
  options: WorkerOptions,
): Promise<{ done: number; retried: number; failed: number }> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const concurrency = resolveConcurrency(options.concurrency);
  const onEvent = options.onEvent ?? (() => undefined);
  const counts = { done: 0, retried: 0, failed: 0 };
  let fatal: { error: unknown } | undefined;

  const stop = (error: unknown): void => {
    fatal ??= { error };
  };

  const processJob = async (job: JobRecord): Promise<void> => {
    const started = performance.now();
    try {
      const result = await options.analyze(job.candidate);
      await options.queue.complete(job.id);
      counts.done += 1;
      onEvent({
        kind: "done",
        id: job.id,
        name: job.candidate.name,
        version: job.candidate.version,
        created: result.created,
        elapsedMs: Math.round(performance.now() - started),
      });
    } catch (error: unknown) {
      const message = truncate(messageOf(error), MAX_VALUE_CHARS);
      const state = await options.queue.fail(job.id, message, maxAttempts);
      if (state === "failed") {
        counts.failed += 1;
        onEvent({ kind: "failed", id: job.id, error: message });
      } else {
        counts.retried += 1;
        onEvent({
          kind: "retry",
          id: job.id,
          attempt: job.attempts,
          error: message,
        });
      }
    }
  };

  const runLoop = async (): Promise<void> => {
    for (;;) {
      if (fatal !== undefined) return;
      let job: JobRecord | null;
      try {
        job = await options.queue.claim();
      } catch (error: unknown) {
        stop(error);
        return;
      }
      if (job === null) return;
      try {
        await processJob(job);
      } catch (error: unknown) {
        stop(error);
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runLoop()));
  if (fatal !== undefined) throw fatal.error;
  return counts;
}

function resolveMaxAttempts(value: number | undefined): number {
  const maxAttempts = value ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new WorkerError(
      `maxAttempts must be a positive integer, got ${String(maxAttempts)}`,
    );
  }
  return maxAttempts;
}

function resolveConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CONCURRENCY;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CONCURRENCY
  ) {
    throw new WorkerError(
      `concurrency must be an integer between 1 and ${String(MAX_CONCURRENCY)}, got ${String(concurrency)}`,
    );
  }
  return concurrency;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
