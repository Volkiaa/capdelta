import { NamedError } from "../core/named-error.js";
import type { JsonRunReport } from "../core/report-contract.js";
import { MAX_IDENTITY_CHARS, truncate } from "../core/report-builder.js";
import { encodeKey, type JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";

export interface ReleaseRecord {
  schemaVersion: 1;
  ecosystem: "npm";
  name: string;
  version: string;
  digest: string;
  previousVersion: string | null;
  previousDigest: string | null;
  analyzerVersion: string;
  analyzedAt: string; // ISO
  status: "complete" | "incomplete";
  /** Why the analysis was incomplete (bounded strings). Empty when complete. */
  incompleteReasons: string[];
  report: JsonRunReport;
}

export class ReleaseStoreError extends NamedError {}

const RELEASE_KIND = "release";
const VERSION_INDEX_KIND = "release-by-version";
const DIGEST_INDEX_KIND = "release-by-digest";

export function releaseKey(
  c: Pick<ReleaseCandidate, "name" | "version" | "digest" | "previous">,
  analyzerVersion: string,
): string {
  return encodeKey(
    [
      analyzerVersion,
      c.name,
      c.version,
      c.digest,
      c.previous?.digest ?? "",
    ].join("\n"),
  );
}

/** One process owns a store; the mutex is in-memory only. */
export class ReleaseStore {
  private readonly store: JsonStore;
  private indexQueue: Promise<unknown> = Promise.resolve();

  constructor(store: JsonStore) {
    this.store = store;
  }

  async get(key: string): Promise<ReleaseRecord | null> {
    const value = await this.store.get(RELEASE_KIND, key);
    if (value === null) return null;
    return parseRecord(value, key);
  }

  async putIfAbsent(record: ReleaseRecord): Promise<boolean> {
    const key = releaseKey(toCandidate(record), record.analyzerVersion);
    // Write the validated copy so extra runtime fields cannot reach the file.
    const validated = parseRecord(record, key);
    const created = await this.store.putIfAbsent(RELEASE_KIND, key, validated);
    await this.withIndexLock(async () => {
      await this.addToIndex(
        VERSION_INDEX_KIND,
        encodeKey(`${record.name}@${record.version}`),
        key,
      );
      await this.addToIndex(DIGEST_INDEX_KIND, encodeKey(record.digest), key);
    });
    return created;
  }

  findByVersion(name: string, version: string): Promise<ReleaseRecord[]> {
    return this.find(VERSION_INDEX_KIND, encodeKey(`${name}@${version}`));
  }

  findByDigest(digest: string): Promise<ReleaseRecord[]> {
    return this.find(DIGEST_INDEX_KIND, encodeKey(digest));
  }

  listKeys(): Promise<string[]> {
    return this.store.list(RELEASE_KIND);
  }

  private async find(kind: string, key: string): Promise<ReleaseRecord[]> {
    const keys = await this.readIndex(kind, key);
    const records: ReleaseRecord[] = [];
    for (const recordKey of keys) {
      const record = await this.get(recordKey);
      if (record !== null) records.push(record);
    }
    return records;
  }

  private async addToIndex(
    kind: string,
    key: string,
    recordKey: string,
  ): Promise<void> {
    const keys = await this.readIndex(kind, key);
    if (keys.includes(recordKey)) return;
    await this.store.put(kind, key, { keys: [...keys, recordKey] });
  }

  private async readIndex(kind: string, key: string): Promise<string[]> {
    const value = await this.store.get(kind, key);
    if (value === null) return [];
    if (
      !isPlainObject(value) ||
      !Array.isArray(value.keys) ||
      !value.keys.every((item): item is string => typeof item === "string")
    ) {
      throw new ReleaseStoreError(
        `invalid "${kind}" index for key ${quote(key)}`,
      );
    }
    return [...new Set(value.keys)];
  }

  private withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.indexQueue.then(operation);
    // The caller still sees a failed update; this only keeps the chain usable.
    this.indexQueue = run.catch(() => undefined);
    return run;
  }
}

function toCandidate(
  record: ReleaseRecord,
): Pick<ReleaseCandidate, "name" | "version" | "digest" | "previous"> {
  return {
    name: record.name,
    version: record.version,
    digest: record.digest,
    previous:
      record.previousVersion === null
        ? null
        : {
            version: record.previousVersion,
            digest: record.previousDigest ?? "",
            tarballUrl: "",
          },
  };
}

function parseRecord(value: unknown, key: string): ReleaseRecord {
  if (!isPlainObject(value)) {
    throw invalidRecord(key, "the record is not an object");
  }
  if (value.schemaVersion !== 1) {
    throw invalidRecord(key, "schemaVersion must be 1");
  }
  if (value.ecosystem !== "npm") {
    throw invalidRecord(key, 'ecosystem must be "npm"');
  }
  const name = requireString(value, "name", key);
  const version = requireString(value, "version", key);
  const digest = requireString(value, "digest", key);
  const previousVersion = requireNullableString(value, "previousVersion", key);
  const previousDigest = requireNullableString(value, "previousDigest", key);
  if ((previousVersion === null) !== (previousDigest === null)) {
    throw invalidRecord(
      key,
      "previousVersion and previousDigest must both be set or both be null",
    );
  }
  const analyzerVersion = requireString(value, "analyzerVersion", key);
  const analyzedAt = requireString(value, "analyzedAt", key);
  if (value.status !== "complete" && value.status !== "incomplete") {
    throw invalidRecord(key, 'status must be "complete" or "incomplete"');
  }
  const incompleteReasons = requireStringArray(value, "incompleteReasons", key);
  const report = requireReport(value.report, key);
  return {
    schemaVersion: 1,
    ecosystem: "npm",
    name,
    version,
    digest,
    previousVersion,
    previousDigest,
    analyzerVersion,
    analyzedAt,
    status: value.status,
    incompleteReasons,
    report,
  };
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  key: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidRecord(key, `${field} must be a string`);
  }
  return value;
}

function requireNullableString(
  record: Record<string, unknown>,
  field: string,
  key: string,
): string | null {
  const value = record[field];
  if (value !== null && typeof value !== "string") {
    throw invalidRecord(key, `${field} must be a string or null`);
  }
  return value;
}

function requireStringArray(
  record: Record<string, unknown>,
  field: string,
  key: string,
): string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === "string")
  ) {
    throw invalidRecord(key, `${field} must be an array of strings`);
  }
  return [...value];
}

function requireReport(value: unknown, key: string): JsonRunReport {
  if (!isPlainObject(value) || typeof value.schemaVersion !== "number") {
    throw invalidRecord(
      key,
      "report must be an object with a numeric schemaVersion",
    );
  }
  return value as unknown as JsonRunReport;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRecord(key: string, detail: string): ReleaseStoreError {
  return new ReleaseStoreError(
    `invalid release record for key ${quote(key)}: ${detail}`,
  );
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}
