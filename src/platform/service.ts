import type {
  analyzeChangedPackages,
  CapabilityAnalysisOptions,
} from "../core/capability-analysis-pipeline.js";
import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import { analyzeRelease } from "./analyze-release.js";
import { JobQueue } from "./job-queue.js";
import { JsonStore } from "./json-store.js";
import {
  candidatesForPackage,
  collectReleases,
  type CollectorOptions,
  type CollectorSkipped,
} from "./registry-collector.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import { ReleaseStore } from "./release-store.js";
import { drainQueue, type WorkerEvent } from "./worker.js";

export class ServiceError extends NamedError {}

export interface ServiceConfig {
  dataDir: string;
  collector: CollectorOptions;
  analyzeOptions?: CapabilityAnalysisOptions;
  analyze?: typeof analyzeChangedPackages;
  maxAttempts?: number;
  now?: () => Date;
  onEvent?: (message: string) => void;
}

export interface ServiceHandles {
  store: JsonStore;
  releases: ReleaseStore;
  queue: JobQueue;
}

const CURSOR_KIND = "cursor";
const CURSOR_KEY = "npm-changes";
/** The npm change feed reads this as the current sequence number. */
const FIRST_SINCE = "now";
const CONTROL_CHARACTER = /\p{Cc}/u;

export function openService(config: ServiceConfig): ServiceHandles {
  const store = new JsonStore({ root: config.dataDir });
  return {
    store,
    releases: new ReleaseStore(store),
    queue: new JobQueue(store, config.now),
  };
}

/**
 * One monitor cycle: recover, collect since the stored cursor, enqueue,
 * persist the cursor, drain. The cursor moves only after every candidate is
 * queued, so a crash replays the page and enqueue idempotency absorbs it.
 */
export async function monitorOnce(config: ServiceConfig): Promise<{
  enqueued: number;
  skipped: number;
  done: number;
  failed: number;
  cursor: string;
}> {
  const handles = openService(config);
  await handles.queue.recover();

  const since = await readCursor(handles.store);
  const collected = await collectReleases(since, config.collector);
  reportSkipped(config, collected.skipped);
  const cursor = collected.nextSince;
  if (!isUsableCursor(cursor)) {
    throw new ServiceError(
      "the change feed returned a cursor that is empty, too long, or has control characters",
    );
  }

  let enqueued = 0;
  for (const candidate of collected.candidates) {
    if (await handles.queue.enqueue(candidate)) {
      enqueued += 1;
      emit(config, `enqueued ${identity(candidate.name, candidate.version)}`);
    }
  }

  await handles.store.put(CURSOR_KIND, CURSOR_KEY, { since: cursor });

  const drained = await drain(config, handles);
  return {
    enqueued,
    skipped: collected.skipped.length,
    done: drained.done,
    failed: drained.failed,
    cursor,
  };
}

/** Analyze one named release now, without the change feed. */
export async function analyzeOne(
  config: ServiceConfig,
  name: string,
  version: string,
): Promise<{ done: number; failed: number }> {
  const handles = openService(config);
  const { candidates, skipped } = await candidatesForPackage(
    name,
    config.collector,
    new Set([version]),
  );
  reportSkipped(config, skipped);

  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new ServiceError(
      `cannot analyze ${identity(name, version)}: ${noReleaseReason(skipped)}`,
    );
  }

  await handles.queue.enqueue(candidate);
  const drained = await drain(config, handles);
  return { done: drained.done, failed: drained.failed };
}

async function readCursor(store: JsonStore): Promise<string> {
  const value = await store.get(CURSOR_KIND, CURSOR_KEY);
  if (value === null) return FIRST_SINCE;
  if (!isRecord(value) || !isUsableCursor(value.since)) {
    throw new ServiceError(
      `invalid cursor record for "${CURSOR_KEY}": expected { since: string } with a bounded, non-empty since`,
    );
  }
  return value.since;
}

/** last_seq is registry-controlled and becomes a URL parameter and a stored value. */
function isUsableCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_VALUE_CHARS &&
    !CONTROL_CHARACTER.test(value)
  );
}

function drain(
  config: ServiceConfig,
  handles: ServiceHandles,
): ReturnType<typeof drainQueue> {
  return drainQueue({
    queue: handles.queue,
    analyze: (candidate) => analyzeCandidate(config, handles, candidate),
    ...(config.maxAttempts === undefined
      ? {}
      : { maxAttempts: config.maxAttempts }),
    onEvent: (event) => {
      reportWorkerEvent(config, event);
    },
  });
}

async function analyzeCandidate(
  config: ServiceConfig,
  handles: ServiceHandles,
  candidate: ReleaseCandidate,
): Promise<{ created: boolean }> {
  const result = await analyzeRelease(candidate, {
    store: handles.releases,
    ...(config.analyze === undefined ? {} : { analyze: config.analyze }),
    ...(config.analyzeOptions === undefined
      ? {}
      : { analyzeOptions: config.analyzeOptions }),
    ...(config.now === undefined ? {} : { now: config.now }),
  });
  emit(
    config,
    `analyzed ${identity(candidate.name, candidate.version)}${result.created ? "" : " (record already present)"}`,
  );
  return { created: result.created };
}

function reportWorkerEvent(config: ServiceConfig, event: WorkerEvent): void {
  if (event.kind === "retry") {
    emit(
      config,
      `retrying job ${event.id} (attempt ${String(event.attempt)}): ${event.error}`,
    );
  }
  if (event.kind === "failed") {
    emit(config, `job ${event.id} failed: ${event.error}`);
  }
}

function reportSkipped(
  config: ServiceConfig,
  skipped: readonly CollectorSkipped[],
): void {
  for (const entry of skipped) {
    emit(
      config,
      `skipped ${truncate(entry.name, MAX_IDENTITY_CHARS)}: ${truncate(entry.reason, MAX_VALUE_CHARS)}`,
    );
  }
}

function noReleaseReason(skipped: readonly CollectorSkipped[]): string {
  if (skipped.length === 0) return "the registry does not publish that version";
  const details = skipped
    .map((entry) => truncate(`${entry.name}: ${entry.reason}`, MAX_VALUE_CHARS))
    .join("; ");
  return `no usable release was found (${truncate(details, MAX_VALUE_CHARS)})`;
}

function emit(config: ServiceConfig, message: string): void {
  config.onEvent?.(message);
}

function identity(name: string, version: string): string {
  return `${truncate(name, MAX_IDENTITY_CHARS)}@${truncate(version, MAX_IDENTITY_CHARS)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
