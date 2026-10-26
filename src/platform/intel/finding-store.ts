import { NamedError } from "../../core/named-error.js";
import { MAX_IDENTITY_CHARS, truncate } from "../../core/report-builder.js";
import { encodeKey, type JsonStore } from "../json-store.js";
import {
  type Confidence,
  type EvidenceRef,
  type IntelFinding,
  type Severity,
  type Transition,
  type TransitionRequest,
  type Validation,
  type Verdict,
} from "./finding.js";
import { applyTransition, findingId } from "./finding.js";

export class FindingStoreError extends NamedError {}

const FINDING_KIND = "finding";
const PACKAGE_INDEX_KIND = "finding-by-package";
const DIGEST_INDEX_KIND = "finding-by-digest";
const FEED_KIND = "feed";
const FEED_META_KIND = "feed-meta";
const FEED_HEAD_KEY = "head";
const FEED_KEY_PATTERN = /^entry-(\d{12})$/;
const MAX_RECENT_RECORDS = 1000;

const SEVERITIES: readonly Severity[] = [
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
];
const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high"];
const VERDICTS: readonly Verdict[] = [
  "suspected",
  "under-review",
  "confirmed-malicious",
  "benign",
  "retracted",
];
const PUBLISHED: ReadonlySet<Verdict> = new Set([
  "confirmed-malicious",
  "retracted",
]);

/** The finding as published at that sequence, so a later review state cannot hide a retraction. */
interface FeedEntry {
  sequence: number;
  id: string;
  revision: number;
  finding: IntelFinding;
}

export interface FeedPage {
  entries: { sequence: number; finding: IntelFinding }[];
  lastSequence: number;
}

/** One process owns a store; the mutex is in-memory only. */
export class FindingStore {
  private readonly store: JsonStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: JsonStore) {
    this.store = store;
  }

  async putIfAbsent(
    finding: IntelFinding,
  ): Promise<{ finding: IntelFinding; created: boolean }> {
    const validated = parseFinding(finding, finding.id);
    if (
      validated.verdict !== "suspected" ||
      validated.revision !== 1 ||
      validated.history.length !== 0 ||
      validated.id !== findingId(validated)
    ) {
      throw new FindingStoreError(
        `cannot insert finding ${quote(validated.id)}: only a new suspected finding with its derived id may be inserted`,
      );
    }

    return this.withLock(async () => {
      const created = await this.store.putIfAbsent(
        FINDING_KIND,
        validated.id,
        validated,
      );
      await this.addToIndex(
        PACKAGE_INDEX_KIND,
        encodeKey(validated.name),
        validated.id,
        validated.name,
      );
      await this.addToIndex(
        DIGEST_INDEX_KIND,
        encodeKey(validated.digest),
        validated.id,
        validated.digest,
      );

      if (created) return { finding: validated, created: true };

      const stored = await this.get(validated.id);
      if (stored === null) {
        throw new FindingStoreError(
          `finding ${quote(validated.id)} disappeared during a concurrent write`,
        );
      }
      return { finding: stored, created: false };
    });
  }

  async get(id: string): Promise<IntelFinding | null> {
    if (typeof id !== "string" || id.length === 0) {
      throw new FindingStoreError("cannot read a finding with an empty id");
    }
    const value = await this.store.get(FINDING_KIND, id);
    if (value === null) return null;
    return parseFinding(value, id);
  }

  async transition(
    id: string,
    request: TransitionRequest,
    now: Date,
  ): Promise<IntelFinding> {
    return this.withLock(async () => {
      const current = await this.get(id);
      if (current === null) {
        throw new FindingStoreError(
          `cannot transition finding ${quote(id)}: it does not exist`,
        );
      }
      const next = applyTransition(current, request, now);
      await this.store.put(FINDING_KIND, id, next);
      if (PUBLISHED.has(next.verdict)) await this.appendFeed(next);
      return next;
    });
  }

  async findByPackage(name: string, version?: string): Promise<IntelFinding[]> {
    const ids = await this.readIndex(PACKAGE_INDEX_KIND, encodeKey(name), name);
    const matches: IntelFinding[] = [];
    for (const id of ids) {
      const finding = await this.get(id);
      if (finding === null) continue;
      if (version !== undefined && finding.version !== version) continue;
      matches.push(finding);
    }
    return matches;
  }

  async findByDigest(digest: string): Promise<IntelFinding[]> {
    const ids = await this.readIndex(
      DIGEST_INDEX_KIND,
      encodeKey(digest),
      digest,
    );
    const matches: IntelFinding[] = [];
    for (const id of ids) {
      const finding = await this.get(id);
      if (finding !== null) matches.push(finding);
    }
    return matches;
  }

  /**
   * The most recently updated findings among at most the 1000 newest record
   * files by modification time, optionally filtered to one verdict. The mtime
   * scan bounds the work per request; `updatedAt` decides the order.
   */
  async listRecent(limit: number, verdict?: Verdict): Promise<IntelFinding[]> {
    const files = (await this.store.listWithTimes(FINDING_KIND)).slice(
      0,
      MAX_RECENT_RECORDS,
    );
    const findings: IntelFinding[] = [];
    for (const file of files) {
      const finding = await this.get(file.key);
      if (finding === null) continue;
      if (verdict !== undefined && finding.verdict !== verdict) continue;
      findings.push(finding);
    }
    // Sort is stable, so findings with the same updatedAt keep mtime order.
    findings.sort(
      (left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt),
    );
    return findings.slice(0, limit);
  }

  async feedSince(sequence: number, limit: number): Promise<FeedPage> {
    if (!isCount(sequence)) {
      throw new FindingStoreError(
        `cannot read the feed after sequence ${quote(String(sequence))}`,
      );
    }
    if (!isCount(limit) || limit === 0) {
      throw new FindingStoreError(
        `cannot read the feed with limit ${quote(String(limit))}`,
      );
    }

    const page = new Map<string, { sequence: number; finding: IntelFinding }>();
    let lastSequence = sequence;

    for (const item of await this.listFeedSequences()) {
      if (item.sequence <= sequence) continue;
      const entry = await this.readFeedEntry(item.key, item.sequence);
      // A newer entry for one finding replaces the older one in the page.
      if (!page.has(entry.id) && page.size >= limit) break;
      page.set(entry.id, { sequence: item.sequence, finding: entry.finding });
      lastSequence = item.sequence;
    }

    return {
      entries: [...page.values()].sort(
        (left, right) => left.sequence - right.sequence,
      ),
      lastSequence,
    };
  }

  private async appendFeed(finding: IntelFinding): Promise<void> {
    const head = await this.readHead();
    // A crash between the entry and the head write must not reuse a sequence.
    const sequences = await this.listFeedSequences();
    const highest = sequences.at(-1)?.sequence ?? 0;
    const sequence = Math.max(head, highest) + 1;
    const entry: FeedEntry = {
      sequence,
      id: finding.id,
      revision: finding.revision,
      finding,
    };
    await this.store.put(FEED_KIND, feedKey(sequence), entry);
    await this.store.put(FEED_META_KIND, FEED_HEAD_KEY, { sequence });
  }

  private async readHead(): Promise<number> {
    const value = await this.store.get(FEED_META_KIND, FEED_HEAD_KEY);
    if (value === null) return 0;
    if (!isPlainObject(value) || !isCount(value.sequence)) {
      throw new FindingStoreError("invalid feed head record");
    }
    return value.sequence;
  }

  private async listFeedSequences(): Promise<
    { key: string; sequence: number }[]
  > {
    const keys = await this.store.list(FEED_KIND);
    return keys
      .map((key) => {
        const match = FEED_KEY_PATTERN.exec(key);
        if (match?.[1] === undefined) {
          throw new FindingStoreError(`invalid feed entry key ${quote(key)}`);
        }
        return { key, sequence: Number(match[1]) };
      })
      .sort((left, right) => left.sequence - right.sequence);
  }

  private async readFeedEntry(
    key: string,
    sequence: number,
  ): Promise<FeedEntry> {
    const value = await this.store.get(FEED_KIND, key);
    if (value === null) {
      throw new FindingStoreError(
        `feed entry ${quote(key)} disappeared while it was being read`,
      );
    }
    if (!isPlainObject(value)) {
      throw new FindingStoreError(`invalid feed entry ${quote(key)}`);
    }
    if (value.sequence !== sequence) {
      throw new FindingStoreError(
        `invalid feed entry ${quote(key)}: its sequence does not match its key`,
      );
    }
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new FindingStoreError(
        `invalid feed entry ${quote(key)}: id must be a non-empty string`,
      );
    }
    if (!isCount(value.revision) || value.revision === 0) {
      throw new FindingStoreError(
        `invalid feed entry for ${quote(value.id)}: revision must be a positive integer`,
      );
    }
    return {
      sequence,
      id: value.id,
      revision: value.revision,
      finding: parseFinding(value.finding, value.id),
    };
  }

  private async addToIndex(
    kind: string,
    key: string,
    id: string,
    label: string,
  ): Promise<void> {
    const ids = await this.readIndex(kind, key, label);
    if (ids.includes(id)) return;
    await this.store.put(kind, key, { ids: [...ids, id] });
  }

  private async readIndex(
    kind: string,
    key: string,
    label: string,
  ): Promise<string[]> {
    const value = await this.store.get(kind, key);
    if (value === null) return [];
    if (
      !isPlainObject(value) ||
      !Array.isArray(value.ids) ||
      !value.ids.every((item): item is string => typeof item === "string")
    ) {
      throw new FindingStoreError(
        `invalid "${kind}" index for ${quote(label)}`,
      );
    }
    return [...new Set(value.ids)];
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    // The caller still sees a failed write; this only keeps the chain usable.
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function feedKey(sequence: number): string {
  return `entry-${String(sequence).padStart(12, "0")}`;
}

/** ISO timestamps sort by text when they are well formed; parse to be sure. */
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parseFinding(value: unknown, id: string): IntelFinding {
  if (typeof id !== "string" || id.length === 0) {
    throw new FindingStoreError(
      "invalid finding record: id must be a non-empty string",
    );
  }
  if (!isPlainObject(value)) {
    throw invalidFinding(id, "the record is not an object");
  }
  if (value.schemaVersion !== 1) {
    throw invalidFinding(id, "schemaVersion must be 1");
  }
  if (value.id !== id) {
    throw invalidFinding(id, "the stored id does not match the record key");
  }
  if (value.ecosystem !== "npm") {
    throw invalidFinding(id, 'ecosystem must be "npm"');
  }

  const revision = value.revision;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    throw invalidFinding(id, "revision must be a positive integer");
  }

  return {
    schemaVersion: 1,
    id,
    ecosystem: "npm",
    name: requireString(value, "name", id),
    version: requireString(value, "version", id),
    digest: requireString(value, "digest", id),
    analyzerVersion: requireString(value, "analyzerVersion", id),
    ruleKey: requireString(value, "ruleKey", id),
    summary: requireString(value, "summary", id),
    severity: requireEnum(value.severity, SEVERITIES, "severity", id),
    confidence: requireEnum(value.confidence, CONFIDENCES, "confidence", id),
    verdict: requireEnum(value.verdict, VERDICTS, "verdict", id),
    evidence: parseEvidence(value.evidence, id),
    revision,
    createdAt: requireString(value, "createdAt", id),
    updatedAt: requireString(value, "updatedAt", id),
    history: parseHistory(value.history, id),
  };
}

function parseEvidence(value: unknown, id: string): EvidenceRef[] {
  if (!Array.isArray(value)) {
    throw invalidFinding(id, "evidence must be an array");
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw invalidFinding(id, `evidence[${String(index)}] must be an object`);
    }
    const file = requireString(item, "file", id);
    const line = item.line;
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw invalidFinding(
        id,
        `evidence[${String(index)}].line must be a positive integer`,
      );
    }
    return { file, line, excerpt: requireString(item, "excerpt", id) };
  });
}

function parseHistory(value: unknown, id: string): Transition[] {
  if (!Array.isArray(value)) {
    throw invalidFinding(id, "history must be an array");
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw invalidFinding(id, `history[${String(index)}] must be an object`);
    }
    const entry: Transition = {
      at: requireString(item, "at", id),
      actor: requireString(item, "actor", id),
      from: requireEnum(
        item.from,
        VERDICTS,
        `history[${String(index)}].from`,
        id,
      ),
      to: requireEnum(item.to, VERDICTS, `history[${String(index)}].to`, id),
      reason: requireString(item, "reason", id),
    };
    if (item.validation !== undefined) {
      entry.validation = parseValidation(item.validation, id, index);
    }
    return entry;
  });
}

function parseValidation(
  value: unknown,
  id: string,
  index: number,
): Validation {
  if (!isPlainObject(value)) {
    throw invalidFinding(
      id,
      `history[${String(index)}].validation must be an object`,
    );
  }
  const refs = value.evidenceRefs;
  if (
    !Array.isArray(refs) ||
    !refs.every(
      (ref): ref is number =>
        typeof ref === "number" && Number.isInteger(ref) && ref >= 0,
    )
  ) {
    throw invalidFinding(
      id,
      `history[${String(index)}].validation.evidenceRefs must be an array of non-negative integers`,
    );
  }
  return {
    reviewer: requireString(value, "reviewer", id),
    method: requireString(value, "method", id),
    evidenceRefs: [...refs],
  };
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  id: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw invalidFinding(id, `${field} must be a string`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  id: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalidFinding(id, `${field} is not a known value`);
  }
  return value as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function invalidFinding(id: string, detail: string): FindingStoreError {
  return new FindingStoreError(
    `invalid finding record for ${quote(id)}: ${detail}`,
  );
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}
