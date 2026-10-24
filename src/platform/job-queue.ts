import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import { encodeKey, JsonStore } from "./json-store.js";
import type { ReleaseArtifact, ReleaseCandidate } from "./release-candidate.js";

export type JobState = "pending" | "running" | "done" | "failed";

export interface JobRecord {
  schemaVersion: 1;
  id: string;
  candidate: ReleaseCandidate;
  state: JobState;
  attempts: number;
  lastError: string | null;
  enqueuedAt: string;
  updatedAt: string;
}

export class JobQueueError extends NamedError {}

const KIND = "job";
const STATES: readonly JobState[] = ["pending", "running", "done", "failed"];

export class JobQueue {
  private readonly store: JsonStore;
  private readonly now: () => Date;
  // One process owns the queue, so this chain serializes every read-modify-write.
  private tail: Promise<void> = Promise.resolve();

  constructor(store: JsonStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  /**
   * Idempotent: the same (name, version, digest) never creates a second job.
   * The candidate stays intact: truncating its identity fields would change
   * the job id, and truncating tarballUrl would change what the analyzer
   * fetches. The collector bounds those fields before enqueueing.
   * @returns true when it created one.
   */
  async enqueue(candidate: ReleaseCandidate): Promise<boolean> {
    return this.serialize(async () => {
      const id = encodeKey(
        `${candidate.name}\n${candidate.version}\n${candidate.digest}`,
      );
      const timestamp = this.timestamp();
      const record: JobRecord = {
        schemaVersion: 1,
        id,
        candidate,
        state: "pending",
        attempts: 0,
        lastError: null,
        enqueuedAt: timestamp,
        updatedAt: timestamp,
      };
      // Validate before writing, so a malformed candidate fails at the caller
      // instead of at the next claim. The stored copy drops unknown fields.
      const validated = parseRecord(id, record);
      return this.store.putIfAbsent(KIND, id, validated);
    });
  }

  async get(id: string): Promise<JobRecord | null> {
    return this.serialize(async () => this.read(id));
  }

  async list(state?: JobState): Promise<JobRecord[]> {
    return this.serialize(async () => this.records(state));
  }

  /** Returns every running job to pending. Call once at startup. */
  async recover(): Promise<number> {
    return this.serialize(async () => {
      const running = await this.records("running");
      for (const job of running) {
        await this.store.put(KIND, job.id, {
          ...job,
          state: "pending",
          updatedAt: this.timestamp(),
        });
      }
      return running.length;
    });
  }

  /** Oldest pending job, moved to running with attempts + 1. */
  async claim(): Promise<JobRecord | null> {
    return this.serialize(async () => {
      const pending = await this.records("pending");
      const next = pending[0];
      if (next === undefined) return null;
      const claimed: JobRecord = {
        ...next,
        state: "running",
        attempts: next.attempts + 1,
        updatedAt: this.timestamp(),
      };
      await this.store.put(KIND, next.id, claimed);
      return claimed;
    });
  }

  async complete(id: string): Promise<void> {
    return this.serialize(async () => {
      const job = await this.require(id);
      await this.store.put(KIND, id, {
        ...job,
        state: "done",
        updatedAt: this.timestamp(),
      });
    });
  }

  async fail(
    id: string,
    error: string,
    maxAttempts: number,
  ): Promise<JobState> {
    return this.serialize(async () => {
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new JobQueueError(
          `cannot fail job "${truncate(id, MAX_IDENTITY_CHARS)}": maxAttempts must be a positive integer`,
        );
      }
      const job = await this.require(id);
      const state: JobState = job.attempts < maxAttempts ? "pending" : "failed";
      await this.store.put(KIND, id, {
        ...job,
        state,
        lastError: truncate(error, MAX_VALUE_CHARS),
        updatedAt: this.timestamp(),
      });
      return state;
    });
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async read(id: string): Promise<JobRecord | null> {
    const value = await this.store.get(KIND, id);
    if (value === null) return null;
    return parseRecord(id, value);
  }

  private async require(id: string): Promise<JobRecord> {
    const record = await this.read(id);
    if (record === null) {
      throw new JobQueueError(
        `job "${truncate(id, MAX_IDENTITY_CHARS)}" does not exist`,
      );
    }
    return record;
  }

  private async records(state?: JobState): Promise<JobRecord[]> {
    const keys = await this.store.list(KIND);
    const records = await Promise.all(keys.map((key) => this.require(key)));
    const selected =
      state === undefined
        ? records
        : records.filter((record) => record.state === state);
    return selected.sort(
      (left, right) =>
        left.enqueuedAt.localeCompare(right.enqueuedAt) ||
        left.id.localeCompare(right.id),
    );
  }
}

function parseRecord(key: string, value: unknown): JobRecord {
  if (!isRecord(value)) throw invalid(key, "is not a JSON object");
  if (value.schemaVersion !== 1) {
    throw invalid(
      key,
      `has schemaVersion ${show(value.schemaVersion)} instead of 1`,
    );
  }
  if (value.id !== key) {
    throw invalid(key, `carries id ${show(value.id)} instead of its key`);
  }
  const candidate = parseCandidate(key, value.candidate);
  if (!isJobState(value.state)) {
    throw invalid(key, `has state ${show(value.state)}`);
  }
  if (
    typeof value.attempts !== "number" ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0
  ) {
    throw invalid(key, `has attempts ${show(value.attempts)}`);
  }
  const lastError = value.lastError;
  if (lastError !== null && typeof lastError !== "string") {
    throw invalid(key, "has a lastError that is neither a string nor null");
  }
  return {
    schemaVersion: 1,
    id: key,
    candidate,
    state: value.state,
    attempts: value.attempts,
    lastError,
    enqueuedAt: parseTime(key, value.enqueuedAt, "enqueuedAt"),
    updatedAt: parseTime(key, value.updatedAt, "updatedAt"),
  };
}

function parseCandidate(key: string, value: unknown): ReleaseCandidate {
  if (!isRecord(value)) throw invalid(key, "has no candidate object");
  if (value.ecosystem !== "npm") {
    throw invalid(key, `has ecosystem ${show(value.ecosystem)}`);
  }
  const previous =
    value.previous === null ? null : parseArtifact(key, value.previous);
  return {
    ecosystem: "npm",
    name: parseText(key, value.name, "candidate.name"),
    version: parseText(key, value.version, "candidate.version"),
    digest: parseText(key, value.digest, "candidate.digest"),
    tarballUrl: parseText(key, value.tarballUrl, "candidate.tarballUrl"),
    previous,
    publishedAt: parseTime(key, value.publishedAt, "candidate.publishedAt"),
  };
}

function parseArtifact(key: string, value: unknown): ReleaseArtifact {
  if (!isRecord(value)) throw invalid(key, "has no previous artifact object");
  return {
    version: parseText(key, value.version, "previous.version"),
    digest: parseText(key, value.digest, "previous.digest"),
    tarballUrl: parseText(key, value.tarballUrl, "previous.tarballUrl"),
  };
}

function parseText(key: string, value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(key, `has no ${field}`);
  }
  return value;
}

function parseTime(key: string, value: unknown, field: string): string {
  const text = parseText(key, value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw invalid(key, `has an unparseable ${field}`);
  }
  return text;
}

function isJobState(value: unknown): value is JobState {
  return STATES.includes(value as JobState);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounds a rejected value before it reaches an error message. */
function show(value: unknown): string {
  const text =
    typeof value === "string" ? JSON.stringify(value) : String(value);
  return truncate(text, MAX_VALUE_CHARS);
}

function invalid(key: string, detail: string): JobQueueError {
  return new JobQueueError(
    `invalid job "${truncate(key, MAX_IDENTITY_CHARS)}": it ${detail}`,
  );
}
