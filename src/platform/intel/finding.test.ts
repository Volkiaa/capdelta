import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_FILE_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
} from "../../core/report-builder.js";
import {
  applyTransition,
  createFinding,
  findingId,
  IntelModelError,
  type IntelFinding,
  type NewFindingInput,
  type TransitionRequest,
  type Verdict,
} from "./finding.js";

const CREATED = new Date("2026-10-24T00:00:00.000Z");
const LATER = new Date("2026-10-24T01:00:00.000Z");

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

function input(overrides: Partial<NewFindingInput> = {}): NewFindingInput {
  return { ...BASE_INPUT, ...overrides };
}

function created(overrides: Partial<NewFindingInput> = {}): IntelFinding {
  return createFinding(input(overrides), CREATED);
}

function request(to: Verdict): TransitionRequest {
  if (to !== "confirmed-malicious") {
    return { to, actor: "alice", reason: "triage" };
  }
  return {
    to,
    actor: "alice",
    reason: "reviewed the hook by hand",
    validation: {
      reviewer: "alice",
      method: "manual diff review",
      evidenceRefs: [0],
    },
  };
}

function findingIn(verdict: Verdict): IntelFinding {
  const base = created();
  const underReview = applyTransition(
    base,
    { to: "under-review", actor: "alice", reason: "triage" },
    LATER,
  );
  switch (verdict) {
    case "suspected":
      return base;
    case "under-review":
      return underReview;
    case "benign":
      return applyTransition(
        base,
        { to: "benign", actor: "alice", reason: "known build step" },
        LATER,
      );
    case "confirmed-malicious":
      return applyTransition(
        underReview,
        request("confirmed-malicious"),
        LATER,
      );
    case "retracted":
      return applyTransition(
        applyTransition(underReview, request("confirmed-malicious"), LATER),
        { to: "retracted", actor: "alice", reason: "false positive" },
        LATER,
      );
  }
}

const ALLOWED = new Set([
  "suspected>under-review",
  "suspected>benign",
  "under-review>confirmed-malicious",
  "under-review>benign",
  "confirmed-malicious>retracted",
  "benign>under-review",
  "retracted>under-review",
]);

const VERDICTS: Verdict[] = [
  "suspected",
  "under-review",
  "confirmed-malicious",
  "benign",
  "retracted",
];

describe("findingId", () => {
  it("is stable for one artifact and rule", () => {
    const first = findingId(input());
    const second = findingId({ ...input() });

    expect(first).toBe(second);
    expect(first).toMatch(/^CDI-[0-9a-f]{20}$/);
  });

  it("changes when any identity field changes", () => {
    const base = findingId(input());
    const variants = [
      findingId(input({ name: "left-pad2" })),
      findingId(input({ version: "1.3.1" })),
      findingId(input({ digest: "sha512-def456" })),
      findingId(input({ ruleKey: "shape:install-hook-removed" })),
    ];

    for (const variant of variants) expect(variant).not.toBe(base);
  });

  it("is a fixed known digest", () => {
    // Independent worked example: sha256 of the five fields joined by "\n".
    expect(findingId(input())).toBe("CDI-27a9cdf9ea0b7a88effc");
  });
});

describe("createFinding", () => {
  it("starts suspected at revision 1 with empty history", () => {
    const finding = created();

    expect(finding.verdict).toBe("suspected");
    expect(finding.revision).toBe(1);
    expect(finding.history).toEqual([]);
    expect(finding.severity).toBe("HIGH");
    expect(finding.confidence).toBe("medium");
    expect(finding.createdAt).toBe(CREATED.toISOString());
    expect(finding.updatedAt).toBe(CREATED.toISOString());
    expect(finding.id).toBe(findingId(input()));
  });

  it("bounds every attacker-controlled string", () => {
    const long = "x".repeat(1000);
    const finding = created({
      name: long,
      version: long,
      digest: long,
      analyzerVersion: long,
      ruleKey: long,
      summary: long,
      evidence: [{ file: long, line: 1, excerpt: long }],
    });

    const values = [
      finding.name,
      finding.version,
      finding.digest,
      finding.analyzerVersion,
      finding.ruleKey,
      finding.summary,
      finding.evidence[0]?.file,
      finding.evidence[0]?.excerpt,
    ];
    const limits = [
      MAX_IDENTITY_CHARS,
      MAX_IDENTITY_CHARS,
      MAX_IDENTITY_CHARS,
      MAX_IDENTITY_CHARS,
      MAX_IDENTITY_CHARS,
      MAX_VALUE_CHARS,
      MAX_EVIDENCE_FILE_CHARS,
      MAX_VALUE_CHARS,
    ];

    values.forEach((value, index) => {
      expect(Array.from(value ?? "").length).toBeLessThanOrEqual(
        limits[index] ?? 0,
      );
    });
  });

  it("rejects more than twenty evidence references", () => {
    const evidence = Array.from({ length: 21 }, (_, index) => ({
      file: `file-${String(index)}.js`,
      line: 1,
      excerpt: "x",
    }));

    expect(() => created({ evidence })).toThrow(IntelModelError);
  });

  it("rejects an unknown severity or confidence", () => {
    expect(() => created({ severity: "SEVERE" as unknown as "HIGH" })).toThrow(
      IntelModelError,
    );
    expect(() =>
      created({ confidence: "certain" as unknown as "high" }),
    ).toThrow(IntelModelError);
  });
});

describe("applyTransition", () => {
  it("allows exactly the seven transitions in the design", () => {
    for (const from of VERDICTS) {
      for (const to of VERDICTS) {
        const finding = findingIn(from);
        const allowed = ALLOWED.has(`${from}>${to}`);
        const act = () => applyTransition(finding, request(to), LATER);

        if (allowed) {
          const next = act();
          expect(next.verdict).toBe(to);
          expect(next.revision).toBe(finding.revision + 1);
          expect(next.history).toHaveLength(finding.history.length + 1);
        } else {
          expect(act).toThrow(IntelModelError);
          expect(act).toThrow(finding.id);
        }
      }
    }
  });

  it("appends one history entry with actor, time, reason and endpoints", () => {
    const finding = created();
    const next = applyTransition(
      finding,
      { to: "under-review", actor: "  alice  ", reason: " triage " },
      LATER,
    );

    expect(next.history).toEqual([
      {
        at: LATER.toISOString(),
        actor: "alice",
        from: "suspected",
        to: "under-review",
        reason: "triage",
      },
    ]);
    expect(next.updatedAt).toBe(LATER.toISOString());
    expect(next.createdAt).toBe(finding.createdAt);
  });

  it("never mutates the input finding or shares its arrays", () => {
    const finding = created();
    const snapshot = structuredClone(finding);
    const next = applyTransition(finding, request("under-review"), LATER);

    expect(finding).toEqual(snapshot);
    expect(next).not.toBe(finding);
    expect(next.history).not.toBe(finding.history);
    expect(next.evidence).not.toBe(finding.evidence);
    expect(next.severity).toBe(finding.severity);
    expect(next.confidence).toBe(finding.confidence);
    expect(next.evidence).toEqual(finding.evidence);
  });

  it("rejects an empty or oversized actor", () => {
    const finding = created();
    expect(() =>
      applyTransition(
        finding,
        { to: "under-review", actor: "   ", reason: "triage" },
        LATER,
      ),
    ).toThrow(IntelModelError);
    expect(() =>
      applyTransition(
        finding,
        {
          to: "under-review",
          actor: "a".repeat(MAX_IDENTITY_CHARS + 1),
          reason: "triage",
        },
        LATER,
      ),
    ).toThrow(IntelModelError);
  });

  it("never lets the analyzer transition, under any casing", () => {
    const finding = created();
    for (const actor of ["analyzer", "Analyzer", "ANALYZER"]) {
      expect(() =>
        applyTransition(
          finding,
          { to: "under-review", actor, reason: "x" },
          LATER,
        ),
      ).toThrow(IntelModelError);
    }
  });

  it("requires a non-empty reason", () => {
    const finding = created();
    expect(() =>
      applyTransition(
        finding,
        { to: "under-review", actor: "alice", reason: "  " },
        LATER,
      ),
    ).toThrow(IntelModelError);
  });

  it("bounds the reason to MAX_VALUE_CHARS", () => {
    const next = applyTransition(
      created(),
      { to: "under-review", actor: "alice", reason: "r".repeat(1000) },
      LATER,
    );

    expect(
      Array.from(next.history[0]?.reason ?? "").length,
    ).toBeLessThanOrEqual(MAX_VALUE_CHARS);
  });
});

describe("confirmation validation", () => {
  const underReview = (): IntelFinding => findingIn("under-review");

  function confirm(validation?: TransitionRequest["validation"]): IntelFinding {
    return applyTransition(
      underReview(),
      {
        to: "confirmed-malicious",
        actor: "alice",
        reason: "reviewed",
        ...(validation === undefined ? {} : { validation }),
      },
      LATER,
    );
  }

  it("stores a validation whose reviewer matches the actor", () => {
    const next = confirm({
      reviewer: "alice",
      method: "manual diff review",
      evidenceRefs: [0],
    });

    expect(next.verdict).toBe("confirmed-malicious");
    expect(next.history.at(-1)?.validation).toEqual({
      reviewer: "alice",
      method: "manual diff review",
      evidenceRefs: [0],
    });
  });

  it("rejects a missing validation", () => {
    expect(() => confirm()).toThrow(IntelModelError);
  });

  it("rejects an empty reviewer or method", () => {
    expect(() =>
      confirm({ reviewer: "  ", method: "review", evidenceRefs: [0] }),
    ).toThrow(IntelModelError);
    expect(() =>
      confirm({ reviewer: "alice", method: " ", evidenceRefs: [0] }),
    ).toThrow(IntelModelError);
  });

  it("rejects the analyzer as reviewer", () => {
    expect(() =>
      confirm({ reviewer: "analyzer", method: "review", evidenceRefs: [0] }),
    ).toThrow(IntelModelError);
    expect(() =>
      confirm({ reviewer: "ANALYZER", method: "review", evidenceRefs: [0] }),
    ).toThrow(IntelModelError);
  });

  it("rejects a reviewer who is not the actor", () => {
    expect(() =>
      confirm({ reviewer: "bob", method: "review", evidenceRefs: [0] }),
    ).toThrow(IntelModelError);
  });

  it("rejects missing, non-integer or out-of-range evidence indexes", () => {
    expect(() =>
      confirm({ reviewer: "alice", method: "review", evidenceRefs: [] }),
    ).toThrow(IntelModelError);
    expect(() =>
      confirm({ reviewer: "alice", method: "review", evidenceRefs: [1.5] }),
    ).toThrow(IntelModelError);
    expect(() =>
      confirm({ reviewer: "alice", method: "review", evidenceRefs: [1] }),
    ).toThrow(IntelModelError);
    expect(() =>
      confirm({ reviewer: "alice", method: "review", evidenceRefs: [-1] }),
    ).toThrow(IntelModelError);
  });

  it("rejects a validation on any other transition", () => {
    const finding = created();
    expect(() =>
      applyTransition(
        finding,
        {
          to: "under-review",
          actor: "alice",
          reason: "triage",
          validation: {
            reviewer: "alice",
            method: "review",
            evidenceRefs: [0],
          },
        },
        LATER,
      ),
    ).toThrow(IntelModelError);
  });
});
