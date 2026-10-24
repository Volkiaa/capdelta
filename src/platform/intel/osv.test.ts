import { describe, expect, it } from "vitest";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
} from "../../core/report-builder.js";
import {
  applyTransition,
  createFinding,
  type IntelFinding,
  type NewFindingInput,
} from "./finding.js";
import { OsvError, toOsv } from "./osv.js";

const T0 = new Date("2026-10-01T00:00:00.000Z");
const T1 = new Date("2026-10-02T00:00:00.000Z");
const T2 = new Date("2026-10-03T00:00:00.000Z");
const T3 = new Date("2026-10-04T00:00:00.000Z");

const INPUT: NewFindingInput = {
  ecosystem: "npm",
  name: "left-pad",
  version: "1.3.0",
  digest: "sha512-abc123",
  analyzerVersion: "0.0.0-test",
  ruleKey: "capability:INSTALL_HOOK:added",
  summary: "adds a preinstall hook",
  severity: "CRITICAL",
  confidence: "medium",
  evidence: [
    { file: "package.json", line: 4, excerpt: '"preinstall": "node setup.js"' },
  ],
};

function confirmed(
  overrides: Partial<NewFindingInput> = {},
  at = T2,
): IntelFinding {
  const finding = createFinding({ ...INPUT, ...overrides }, T0);
  const reviewed = applyTransition(
    finding,
    { to: "under-review", actor: "alice", reason: "triage" },
    T1,
  );
  return applyTransition(
    reviewed,
    {
      to: "confirmed-malicious",
      actor: "alice",
      reason: "reviewed the install hook",
      validation: {
        reviewer: "alice",
        method: "manual diff review",
        evidenceRefs: [0],
      },
    },
    at,
  );
}

function retracted(): IntelFinding {
  return applyTransition(
    confirmed(),
    { to: "retracted", actor: "alice", reason: "false positive" },
    T3,
  );
}

describe("toOsv", () => {
  it("renders a confirmed finding without a withdrawal", () => {
    const finding = confirmed();

    const record = toOsv(finding);

    expect(record).toMatchObject({
      schema_version: "1.6.0",
      id: finding.id,
      published: T0.toISOString(),
      modified: T2.toISOString(),
      summary: "adds a preinstall hook",
      affected: [
        {
          package: { ecosystem: "npm", name: "left-pad" },
          versions: ["1.3.0"],
        },
      ],
      database_specific: {
        digest: "sha512-abc123",
        revision: 3,
        verdict: "confirmed-malicious",
        severity: "CRITICAL",
        confidence: "medium",
        analyzerVersion: "0.0.0-test",
        ruleKey: "capability:INSTALL_HOOK:added",
      },
    });
    expect("withdrawn" in record).toBe(false);
    expect(record.details).toContain("adds a preinstall hook");
    expect(record.details).toContain("reviewed the install hook");
  });

  it("withdraws a retracted finding at the retraction time", () => {
    const finding = retracted();

    const record = toOsv(finding);

    expect(record.modified).toBe(T3.toISOString());
    expect(record.withdrawn).toBe(T3.toISOString());
    expect(record.database_specific.verdict).toBe("retracted");
    expect(record.details).toContain("false positive");
  });

  it("bounds every string it writes", () => {
    const finding = confirmed({
      name: "n".repeat(MAX_IDENTITY_CHARS),
      version: "v".repeat(MAX_IDENTITY_CHARS),
      digest: "d".repeat(MAX_IDENTITY_CHARS),
      analyzerVersion: "a".repeat(MAX_IDENTITY_CHARS),
      ruleKey: `r:${"k".repeat(MAX_IDENTITY_CHARS - 2)}`,
      summary: "s".repeat(MAX_VALUE_CHARS + 100),
    });

    const record = toOsv(finding);

    expect(Array.from(record.summary).length).toBeLessThanOrEqual(
      MAX_VALUE_CHARS,
    );
    expect(Array.from(record.details).length).toBeLessThanOrEqual(
      MAX_VALUE_CHARS * 2,
    );
    expect(
      Array.from(record.affected[0]?.package.name ?? "").length,
    ).toBeLessThanOrEqual(MAX_IDENTITY_CHARS);
    expect(
      Array.from(record.affected[0]?.versions[0] ?? "").length,
    ).toBeLessThanOrEqual(MAX_IDENTITY_CHARS);
    for (const value of Object.values(record.database_specific)) {
      if (typeof value === "string") {
        expect(Array.from(value).length).toBeLessThanOrEqual(
          MAX_IDENTITY_CHARS,
        );
      }
    }
  });

  it("refuses a retracted verdict with no retraction transition", () => {
    const finding = { ...confirmed(), verdict: "retracted" as const };

    expect(() => toOsv(finding)).toThrow(OsvError);
    expect(() => toOsv(finding)).toThrow(finding.id);
  });
});
