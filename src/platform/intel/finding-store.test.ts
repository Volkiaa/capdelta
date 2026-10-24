import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../json-store.js";
import {
  createFinding,
  IntelModelError,
  type IntelFinding,
  type NewFindingInput,
  type Verdict,
} from "./finding.js";
import { FindingStore, FindingStoreError } from "./finding-store.js";

const NOW = new Date("2026-10-24T00:00:00.000Z");
const BASE_INPUT: NewFindingInput = {
  ecosystem: "npm",
  name: "left-pad",
  version: "1.3.0",
  digest: "sha512-abc123",
  analyzerVersion: "0.0.0-test",
  ruleKey: "shape:install-hook-added",
  summary: "adds a preinstall hook",
  severity: "HIGH",
  confidence: "medium",
  evidence: [
    { file: "package.json", line: 4, excerpt: '"preinstall": "node setup.js"' },
  ],
};

let base: string;
let root: string;
let jsonStore: JsonStore;
let findings: FindingStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-finding-store-"));
  root = join(base, "root");
  jsonStore = new JsonStore({ root });
  findings = new FindingStore(jsonStore);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<NewFindingInput> = {}): IntelFinding {
  return createFinding({ ...BASE_INPUT, ...overrides }, NOW);
}

function underReview(id: string): Promise<IntelFinding> {
  return findings.transition(
    id,
    { to: "under-review", actor: "alice", reason: "triage" },
    NOW,
  );
}

async function confirm(id: string): Promise<IntelFinding> {
  await underReview(id);
  return findings.transition(
    id,
    {
      to: "confirmed-malicious",
      actor: "alice",
      reason: "reviewed the hook",
      validation: {
        reviewer: "alice",
        method: "manual diff review",
        evidenceRefs: [0],
      },
    },
    NOW,
  );
}

describe("FindingStore.putIfAbsent", () => {
  it("creates once and returns the stored finding on the second write", async () => {
    const finding = makeFinding();

    await expect(findings.putIfAbsent(finding)).resolves.toEqual({
      finding,
      created: true,
    });

    const duplicate = makeFinding({ summary: "different summary" });
    const second = await findings.putIfAbsent(duplicate);

    expect(second.created).toBe(false);
    expect(second.finding.summary).toBe("adds a preinstall hook");
    await expect(findings.get(finding.id)).resolves.toEqual(finding);
  });
});

describe("FindingStore.putIfAbsent insertion rules", () => {
  it("rejects a finding inserted already confirmed", async () => {
    const forged = {
      ...makeFinding(),
      verdict: "confirmed-malicious" as const,
    };

    await expect(findings.putIfAbsent(forged)).rejects.toThrow(
      FindingStoreError,
    );
  });

  it("rejects a finding whose id is not derived from its identity", async () => {
    const forged = { ...makeFinding(), id: "CDI-00000000000000000000" };

    await expect(findings.putIfAbsent(forged)).rejects.toThrow(
      FindingStoreError,
    );
  });
});

describe("FindingStore.transition", () => {
  it("persists the new verdict and revision across store instances", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);

    const next = await findings.transition(
      finding.id,
      { to: "under-review", actor: "alice", reason: "triage" },
      NOW,
    );
    expect(next.revision).toBe(2);
    expect(next.history).toHaveLength(1);

    const reopened = new FindingStore(new JsonStore({ root }));
    const stored = await reopened.get(finding.id);
    expect(stored?.verdict).toBe("under-review");
    expect(stored?.revision).toBe(2);
    expect(stored?.history[0]?.actor).toBe("alice");
  });

  it("throws when the id does not exist", async () => {
    const finding = makeFinding();

    await expect(
      findings.transition(
        finding.id,
        { to: "under-review", actor: "alice", reason: "triage" },
        NOW,
      ),
    ).rejects.toThrow(FindingStoreError);
  });

  it("rejects an illegal transition and leaves the record unchanged", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);

    await expect(
      findings.transition(
        finding.id,
        {
          to: "confirmed-malicious",
          actor: "alice",
          reason: "skip review",
          validation: {
            reviewer: "alice",
            method: "manual",
            evidenceRefs: [0],
          },
        },
        NOW,
      ),
    ).rejects.toThrow(IntelModelError);

    const stored = await findings.get(finding.id);
    expect(stored?.verdict).toBe("suspected");
    expect(stored?.revision).toBe(1);
    expect(stored?.history).toHaveLength(0);
  });

  it("serializes ten concurrent transitions into one consistent history", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        findings.transition(
          finding.id,
          index % 2 === 0
            ? {
                to: "under-review",
                actor: "alice",
                reason: `batch ${String(index)}`,
              }
            : {
                to: "benign",
                actor: "alice",
                reason: `batch ${String(index)}`,
              },
          NOW,
        ),
      ),
    );

    const accepted = results.filter((result) => result.status === "fulfilled");
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(IntelModelError);
      }
    }

    const stored = await findings.get(finding.id);
    expect(stored).not.toBeNull();
    expect(stored?.revision).toBe(1 + accepted.length);
    expect(stored?.history).toHaveLength(accepted.length);

    let state: Verdict = "suspected";
    for (const entry of stored?.history ?? []) {
      expect(entry.from).toBe(state);
      state = entry.to;
    }
    expect(state).toBe(stored?.verdict);
  });
});

describe("FindingStore.feedSince", () => {
  it("publishes nothing while the finding is only suspected", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);

    await expect(findings.feedSince(0, 10)).resolves.toEqual({
      entries: [],
      lastSequence: 0,
    });
  });

  it("publishes nothing for a benign finding", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);
    await findings.transition(
      finding.id,
      { to: "benign", actor: "alice", reason: "known build step" },
      NOW,
    );

    await expect(findings.feedSince(0, 10)).resolves.toEqual({
      entries: [],
      lastSequence: 0,
    });
  });

  it("returns the current finding once it is confirmed", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);
    await confirm(finding.id);

    const feed = await findings.feedSince(0, 10);

    expect(feed.lastSequence).toBe(1);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.sequence).toBe(1);
    expect(feed.entries[0]?.finding.id).toBe(finding.id);
    expect(feed.entries[0]?.finding.verdict).toBe("confirmed-malicious");
  });

  it("returns the retraction at a higher sequence and collapses the page to the newest entry", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);
    await confirm(finding.id);
    await findings.transition(
      finding.id,
      { to: "retracted", actor: "alice", reason: "false positive" },
      NOW,
    );

    const full = await findings.feedSince(0, 10);
    expect(full.lastSequence).toBe(2);
    expect(full.entries).toHaveLength(1);
    expect(full.entries[0]?.sequence).toBe(2);
    expect(full.entries[0]?.finding.verdict).toBe("retracted");

    const sinceFirst = await findings.feedSince(1, 10);
    expect(sinceFirst.entries[0]?.sequence).toBe(2);
  });

  it("respects the limit and resumes at lastSequence", async () => {
    const first = makeFinding();
    const second = makeFinding({ name: "right-pad", digest: "sha512-def456" });
    await findings.putIfAbsent(first);
    await findings.putIfAbsent(second);
    await confirm(first.id);
    await confirm(second.id);

    const page = await findings.feedSince(0, 1);
    expect(page.entries).toHaveLength(1);
    expect(page.lastSequence).toBe(1);

    const next = await findings.feedSince(page.lastSequence, 1);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.sequence).toBe(2);
    expect(next.lastSequence).toBe(2);
  });

  it("publishes the snapshot even when the finding record is gone", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);
    await confirm(finding.id);
    await jsonStore.delete("finding", finding.id);

    const feed = await findings.feedSince(0, 10);

    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.finding.verdict).toBe("confirmed-malicious");
  });

  it("keeps the retraction visible after the finding is reopened for review", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);
    await confirm(finding.id);
    await findings.transition(
      finding.id,
      { to: "retracted", actor: "alice", reason: "false positive" },
      NOW,
    );
    await underReview(finding.id);

    const feed = await findings.feedSince(1, 10);

    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.finding.verdict).toBe("retracted");
    expect(feed.entries[0]?.sequence).toBe(2);
  });

  it("rejects an invalid page request", async () => {
    await expect(findings.feedSince(-1, 10)).rejects.toThrow(FindingStoreError);
    await expect(findings.feedSince(0, 0)).rejects.toThrow(FindingStoreError);
  });
});

describe("FindingStore lookups", () => {
  it("finds findings by package and optional version", async () => {
    const older = makeFinding({ version: "1.2.0", digest: "sha512-old" });
    const newer = makeFinding({ version: "1.3.0" });
    const other = makeFinding({ name: "right-pad", digest: "sha512-other" });
    await findings.putIfAbsent(older);
    await findings.putIfAbsent(newer);
    await findings.putIfAbsent(other);

    expect(await findings.findByPackage("left-pad")).toHaveLength(2);
    const exact = await findings.findByPackage("left-pad", "1.3.0");
    expect(exact.map((finding) => finding.id)).toEqual([newer.id]);
    expect(await findings.findByPackage("absent")).toEqual([]);
  });

  it("finds findings by artifact digest", async () => {
    const finding = makeFinding();
    await findings.putIfAbsent(finding);
    await findings.putIfAbsent(
      makeFinding({ name: "right-pad", digest: "sha512-other" }),
    );

    const matches = await findings.findByDigest("sha512-abc123");

    expect(matches.map((item) => item.id)).toEqual([finding.id]);
    expect(await findings.findByDigest("sha512-none")).toEqual([]);
  });
});

describe("FindingStore read validation", () => {
  it("throws a store error naming the id for a malformed record", async () => {
    const finding = makeFinding();
    await jsonStore.put("finding", finding.id, {
      schemaVersion: 1,
      id: finding.id,
      verdict: "suspected",
    });

    await expect(findings.get(finding.id)).rejects.toThrow(finding.id);
    await expect(findings.get(finding.id)).rejects.toThrow(FindingStoreError);
  });
});
