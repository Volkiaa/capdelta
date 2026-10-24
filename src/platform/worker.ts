import { NamedError } from "../core/named-error.js";
import { MAX_VALUE_CHARS, truncate } from "../core/report-builder.js";
import type { JobQueue } from "./job-queue.js";
import type { ReleaseCandidate } from "./release-candidate.js";

export interface WorkerOptions {
  queue: JobQueue;
  /** Wraps analyzeRelease in the caller. */
  analyze: (candidate: ReleaseCandidate) => Promise<{ created: boolean }>;
  /** Default 3. */
  maxAttempts?: number;
  onEvent?: (event: WorkerEvent) => void;
}

export type WorkerEvent =
  | { kind: "done"; id: string; created: boolean }
  | { kind: "retry"; id: string; attempt: number; error: string }
  | { kind: "failed"; id: string; error: string };

export class WorkerError extends NamedError {}

const DEFAULT_MAX_ATTEMPTS = 3;

/** Processes jobs until the queue has no pending job. */
export async function drainQueue(
  options: WorkerOptions,
): Promise<{ done: number; retried: number; failed: number }> {
  const maxAttempts = resolveMaxAttempts(options.maxAttempts);
  const onEvent = options.onEvent ?? (() => undefined);
  const counts = { done: 0, retried: 0, failed: 0 };

  for (;;) {
    const job = await options.queue.claim();
    if (job === null) return counts;

    try {
      const result = await options.analyze(job.candidate);
      await options.queue.complete(job.id);
      counts.done += 1;
      onEvent({ kind: "done", id: job.id, created: result.created });
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
  }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
