import { NamedError } from "../core/named-error.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  truncate,
} from "../core/report-builder.js";
import { analyzeRelease, type AnalyzeReleaseDeps } from "./analyze-release.js";
import { encodeKey, type JsonStore } from "./json-store.js";
import type { ReleaseCandidate } from "./release-candidate.js";
import type { ReleaseRecord } from "./release-store.js";

export interface BaselineRecord {
  schemaVersion: 1;
  ecosystem: "npm";
  name: string;
  version: string;
  digest: string;
  tarballUrl: string;
  reviewedBy: string;
  reviewedAt: string;
  note: string;
}

export class BaselineError extends NamedError {}

const BASELINE_KIND = "baseline";
const HISTORY_KIND = "baseline-history";

function baselineKey(name: string): string {
  return encodeKey(name);
}

function historyKey(record: BaselineRecord): string {
  return encodeKey(`${record.name}\n${record.reviewedAt}\n${record.digest}`);
}

/**
 * A baseline is an artifact a person reviewed. The analyzer never writes one,
 * so a release cannot move its own reference forward. One process owns a
 * store; the write queue is in-memory only.
 */
export class BaselineStore {
  private readonly store: JsonStore;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(store: JsonStore) {
    this.store = store;
  }

  /** Replaces the baseline for the package and appends one history entry. */
  async set(record: BaselineRecord): Promise<void> {
    const canonical = canonicalize(record);
    const run = this.writeQueue.then(async () => {
      // History first: a baseline never becomes current without an entry.
      await this.store.put(HISTORY_KIND, historyKey(canonical), canonical);
      await this.store.put(
        BASELINE_KIND,
        baselineKey(canonical.name),
        canonical,
      );
    });
    // The caller still sees a failed write; this only keeps the chain usable.
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  async get(name: string): Promise<BaselineRecord | null> {
    const key = baselineKey(name);
    const value = await this.store.get(BASELINE_KIND, key);
    if (value === null) return null;
    const record = parseRecord(value, key);
    if (baselineKey(record.name) !== key) {
      throw invalidRecord(key, "the record name does not match its key");
    }
    return record;
  }

  /** Every reviewed baseline for the package, oldest first. */
  async history(name: string): Promise<BaselineRecord[]> {
    const keys = await this.store.list(HISTORY_KIND);
    const records: BaselineRecord[] = [];
    for (const key of keys) {
      const value = await this.store.get(HISTORY_KIND, key);
      if (value === null) continue;
      const record = parseRecord(value, key);
      if (historyKey(record) !== key) {
        throw invalidRecord(key, "the record does not match its key");
      }
      if (record.name === name) records.push(record);
    }
    return records.sort(compareOldestFirst);
  }
}

/**
 * Compares a release with the last baseline a person reviewed. Returns null
 * when there is no baseline or the candidate is the baseline version.
 */
export async function analyzeAgainstBaseline(
  candidate: ReleaseCandidate,
  baselines: BaselineStore,
  deps: AnalyzeReleaseDeps,
): Promise<{
  record: ReleaseRecord;
  created: boolean;
  baseline: BaselineRecord;
} | null> {
  const baseline = await baselines.get(candidate.name);
  if (baseline === null) return null;
  if (baseline.version === candidate.version) return null;

  const result = await analyzeRelease(
    {
      ...candidate,
      previous: {
        version: baseline.version,
        digest: baseline.digest,
        tarballUrl: baseline.tarballUrl,
      },
    },
    deps,
  );
  return { ...result, baseline };
}

function canonicalize(record: BaselineRecord): BaselineRecord {
  return parseRecord(record, null);
}

function parseRecord(value: unknown, key: string | null): BaselineRecord {
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
  const tarballUrl = requireString(value, "tarballUrl", key);
  const reviewedBy = truncate(
    requireString(value, "reviewedBy", key),
    MAX_IDENTITY_CHARS,
  );
  const reviewedAt = requireString(value, "reviewedAt", key);
  if (Number.isNaN(Date.parse(reviewedAt))) {
    throw invalidRecord(key, "reviewedAt must be an ISO timestamp");
  }
  const note = truncate(requireText(value, "note", key), MAX_VALUE_CHARS);

  return {
    schemaVersion: 1,
    ecosystem: "npm",
    name,
    version,
    digest,
    tarballUrl,
    reviewedBy,
    reviewedAt,
    note,
  };
}

function requireText(
  record: Record<string, unknown>,
  field: string,
  key: string | null,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidRecord(key, `${field} must be a string`);
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  key: string | null,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRecord(key, `${field} must be a non-empty string`);
  }
  return value;
}

function compareOldestFirst(
  left: BaselineRecord,
  right: BaselineRecord,
): number {
  const order = Date.parse(left.reviewedAt) - Date.parse(right.reviewedAt);
  if (order !== 0) return order;
  if (left.digest === right.digest) return 0;
  return left.digest < right.digest ? -1 : 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRecord(key: string | null, detail: string): BaselineError {
  const where = key === null ? "" : ` for key ${quote(key)}`;
  return new BaselineError(`invalid baseline record${where}: ${detail}`);
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}
