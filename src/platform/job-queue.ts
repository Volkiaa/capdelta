import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import { encodeKey, JsonStore } from "./json-store.js";
import type {
  ReleaseArtifact,
  ReleaseCandidate,
  ReleaseChild,
  UnresolvedReleaseChild,
} from "./release-candidate.js";

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

interface PendingEntry {
  id: string;
  enqueuedAt: string;
}

export class JobQueue {
  private readonly store: JsonStore;
  private readonly now: () => Date;
  // One process owns the queue, so this chain serializes every read-modify-write.
  private tail: Promise<void> = Promise.resolve();
  // Pending ids in claim order. The first claim or enqueue fills it from one
  // directory scan; every mutation keeps it current, so a steady-state claim
  // reads only the record it claims.
  private pending: PendingEntry[] = [];
  private loaded = false;

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
      await this.ensureLoaded();
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
      const created = await this.store.putIfAbsent(KIND, id, validated);
      if (created) {
        this.insertPending({ id, enqueuedAt: validated.enqueuedAt });
      }
      return created;
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
      // Drop the cache first: a failure partway through the writes leaves the
      // next call free to rebuild it from disk instead of trusting a mix.
      this.loaded = false;
      const records = await this.records();
      const running = records.filter((record) => record.state === "running");
      const recovered = new Set<string>();
      for (const job of running) {
        await this.store.put(KIND, job.id, {
          ...job,
          state: "pending",
          updatedAt: this.timestamp(),
        });
        recovered.add(job.id);
      }
      this.pending = records
        .filter(
          (record) => record.state === "pending" || recovered.has(record.id),
        )
        .map((record) => ({ id: record.id, enqueuedAt: record.enqueuedAt }));
      this.loaded = true;
      return running.length;
    });
  }

  /** Oldest pending job, moved to running with attempts + 1. */
  async claim(): Promise<JobRecord | null> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const next = this.pending[0];
      if (next === undefined) return null;
      const job = await this.require(next.id);
      const claimed: JobRecord = {
        ...job,
        state: "running",
        attempts: job.attempts + 1,
        updatedAt: this.timestamp(),
      };
      await this.store.put(KIND, next.id, claimed);
      // Drop the id only after the write, so a failed write leaves the job
      // claimable instead of losing it from both the disk order and the cache.
      this.pending.shift();
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
      if (this.loaded) this.removePending(id);
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
      if (this.loaded) {
        this.removePending(id);
        if (state === "pending") {
          this.insertPending({ id, enqueuedAt: job.enqueuedAt });
        }
      }
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

  /** Fills the pending ids from one directory scan. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const records = await this.records();
    this.pending = records
      .filter((record) => record.state === "pending")
      .map((record) => ({ id: record.id, enqueuedAt: record.enqueuedAt }));
    this.loaded = true;
  }

  private insertPending(entry: PendingEntry): void {
    let low = 0;
    let high = this.pending.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const current = this.pending[middle];
      if (current !== undefined && compareClaimOrder(current, entry) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.pending.splice(low, 0, entry);
  }

  private removePending(id: string): void {
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index !== -1) this.pending.splice(index, 1);
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
    return selected.sort(compareClaimOrder);
  }
}

/** Oldest first, then by id so two jobs with the same enqueuedAt keep a stable order. */
function compareClaimOrder(
  left: { id: string; enqueuedAt: string },
  right: { id: string; enqueuedAt: string },
): number {
  return (
    left.enqueuedAt.localeCompare(right.enqueuedAt) ||
    left.id.localeCompare(right.id)
  );
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
    value.previous === null
      ? null
      : parseArtifact(key, value.previous, "previous");
  const children =
    value.children === undefined
      ? undefined
      : parseChildren(key, value.children);
  const unresolvedChildren =
    value.unresolvedChildren === undefined
      ? undefined
      : parseUnresolvedChildren(key, value.unresolvedChildren);
  return {
    ecosystem: "npm",
    name: parseText(key, value.name, "candidate.name"),
    version: parseText(key, value.version, "candidate.version"),
    digest: parseText(key, value.digest, "candidate.digest"),
    tarballUrl: parseText(key, value.tarballUrl, "candidate.tarballUrl"),
    previous,
    publishedAt: parseTime(key, value.publishedAt, "candidate.publishedAt"),
    ...(children === undefined ? {} : { children }),
    ...(unresolvedChildren === undefined ? {} : { unresolvedChildren }),
  };
}

function parseChildren(key: string, value: unknown): ReleaseChild[] {
  if (!Array.isArray(value)) {
    throw invalid(key, "has children that are not an array");
  }
  return value.map((item: unknown) => {
    if (!isRecord(item))
      throw invalid(key, "has a child that is not an object");
    return {
      name: parseText(key, item.name, "child.name"),
      artifact: parseArtifact(key, item.artifact, "child artifact"),
    };
  });
}

function parseUnresolvedChildren(
  key: string,
  value: unknown,
): UnresolvedReleaseChild[] {
  if (!Array.isArray(value)) {
    throw invalid(key, "has unresolvedChildren that are not an array");
  }
  return value.map((item: unknown) => {
    if (!isRecord(item)) {
      throw invalid(key, "has an unresolved child that is not an object");
    }
    return {
      name: parseText(key, item.name, "unresolved child name"),
      reason: parseText(key, item.reason, "unresolved child reason"),
    };
  });
}

function parseArtifact(
  key: string,
  value: unknown,
  field: string,
): ReleaseArtifact {
  if (!isRecord(value)) throw invalid(key, `has no ${field} object`);
  return {
    version: parseText(key, value.version, `${field} version`),
    digest: parseText(key, value.digest, `${field} digest`),
    tarballUrl: parseText(key, value.tarballUrl, `${field} tarballUrl`),
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
