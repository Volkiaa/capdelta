import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  JsonReport,
  JsonReportFinding,
  JsonReportShapeFinding,
  JsonReportSignalFinding,
  JsonRunReport,
  ReportEvidence,
} from "../../core/report-contract.js";
import { REPORT_SCHEMA_VERSION } from "../../core/report-contract.js";
import {
  MAX_EVIDENCE_FILE_CHARS,
  MAX_VALUE_CHARS,
} from "../../core/report-builder.js";
import { JsonStore } from "../json-store.js";
import type { ReleaseRecord } from "../release-store.js";
import { FindingStore } from "./finding-store.js";
import { publishFindings } from "./publish.js";

const NOW = new Date("2026-10-24T00:00:00.000Z");

const EVIDENCE: ReportEvidence[] = [
  { file: "index.js", line: 2, snippet: 'fetch("https://example.test")' },
];

let base: string;
let findings: FindingStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-publish-"));
  findings = new FindingStore(new JsonStore({ root: join(base, "root") }));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function codeFinding(
  kind: "NET" | "PROCESS" | "FS_WRITE" | "ENV",
  severity: JsonReportFinding["severity"],
  suppression?: { reason: string },
): JsonReportFinding {
  return {
    severity,
    change: "added",
    capability: { kind, location: { kind: "runtime" }, evidence: EVIDENCE },
    previous: null,
    ...(suppression === undefined ? {} : { suppression }),
  };
}

function signalFinding(
  kind: JsonReportSignalFinding["kind"],
  severity: JsonReportSignalFinding["severity"],
  suppression?: { reason: string },
): JsonReportSignalFinding {
  return {
    kind,
    severity,
    change: "added",
    detail: `signal ${kind} appeared`,
    evidence: EVIDENCE,
    ...(suppression === undefined ? {} : { suppression }),
  };
}

function shapeFinding(): JsonReportShapeFinding {
  return {
    ruleId: "secret-exfiltration",
    severity: "CRITICAL",
    capabilities: [
      {
        kind: "NET",
        location: { kind: "runtime" },
        evidence: EVIDENCE,
      },
    ],
  };
}

function report(overrides: Partial<JsonReport> = {}): JsonReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    package: {
      ecosystem: "npm",
      name: "alpha",
      oldVersion: "1.0.0",
      newVersion: "2.0.0",
      newPackage: false,
    },
    summary: {
      findings: 0,
      diagnostics: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    },
    findings: [],
    diagnostics: [],
    ...overrides,
  };
}

function runReport(item: JsonReport): JsonRunReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    firstRun: false,
    summary: {
      changedPackages: 1,
      analyzedPackages: 1,
      unavailablePackages: 0,
      skippedLockfileEntries: 0,
      capabilityFindings: item.findings.length,
      signalFindings: item.signalFindings?.length ?? 0,
      analysisDiagnostics: item.diagnostics.length,
      analysisIssues: 0,
      lockfileFindings: 0,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      gateSeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    },
    packages: [
      {
        status: "analyzed",
        report: item,
        issues: [],
        baselineFailures: [],
      },
    ],
    lockfileFindings: [],
    skipped: [],
  };
}

function makeRecord(
  item: JsonReport = report(),
  overrides: Partial<ReleaseRecord> = {},
): ReleaseRecord {
  return {
    schemaVersion: 1,
    ecosystem: "npm",
    name: "alpha",
    version: "2.0.0",
    digest: "sha512-alpha",
    previousVersion: "1.0.0",
    previousDigest: "sha512-alpha-old",
    analyzerVersion: "test-analyzer",
    analyzedAt: "2026-01-01T00:00:00.000Z",
    status: "complete",
    incompleteReasons: [],
    report: runReport(item),
    ...overrides,
  };
}

function mixedReport(): JsonReport {
  return report({
    findings: [
      codeFinding("NET", "HIGH"),
      codeFinding("PROCESS", "MEDIUM"),
      codeFinding("FS_WRITE", "LOW"),
      codeFinding("ENV", "INFO"),
      codeFinding("PROCESS", "CRITICAL", { reason: "expected build step" }),
    ],
    signalFindings: [
      signalFinding("new-external-endpoint", "MEDIUM"),
      signalFinding("entropy-jump", "LOW"),
      signalFinding("obfuscation-pattern-added", "CRITICAL", {
        reason: "vendored bundle",
      }),
    ],
    shapes: [shapeFinding()],
  });
}

async function ruleKeys(record: ReleaseRecord): Promise<string[]> {
  const stored = await findings.findByPackage(record.name, record.version);
  return stored.map((finding) => finding.ruleKey).sort();
}

describe("publishFindings", () => {
  it("creates one suspected finding per MEDIUM or higher unsuppressed finding", async () => {
    const record = makeRecord(mixedReport());

    const counts = await publishFindings(record, findings, () => NOW);

    expect(counts).toEqual({ created: 4, existing: 0 });
    await expect(ruleKeys(record)).resolves.toEqual([
      "capability:NET:added",
      "capability:PROCESS:added",
      "shape:secret-exfiltration",
      "signal:new-external-endpoint",
    ]);
    for (const finding of await findings.findByPackage(
      record.name,
      record.version,
    )) {
      expect(finding).toMatchObject({
        verdict: "suspected",
        confidence: "medium",
        revision: 1,
        history: [],
        analyzerVersion: "test-analyzer",
      });
    }
  });

  it("keeps ids stable and reports existing findings on a repeat publish", async () => {
    const record = makeRecord(mixedReport());
    await publishFindings(record, findings, () => NOW);
    const before = await findings.findByPackage(record.name, record.version);

    const counts = await publishFindings(record, findings, () => NOW);
    const after = await findings.findByPackage(record.name, record.version);

    expect(counts).toEqual({ created: 0, existing: 4 });
    expect(after.map((finding) => finding.id).sort()).toEqual(
      before.map((finding) => finding.id).sort(),
    );
    expect(after.map((finding) => finding.createdAt)).toEqual(
      before.map((finding) => finding.createdAt),
    );
  });

  it("carries bounded evidence and skips entries without a positive integer line", async () => {
    const evidence: ReportEvidence[] = [
      { file: "bad-line.js", line: 0, snippet: "zero" },
      { file: "bad-line.js", line: -2, snippet: "negative" },
      { file: "bad-line.js", line: 1.5, snippet: "fraction" },
      ...Array.from({ length: 25 }, (_, index) => ({
        file: `file-${String(index)}.js`.padEnd(
          MAX_EVIDENCE_FILE_CHARS + 50,
          "x",
        ),
        line: index + 1,
        snippet: "s".repeat(MAX_VALUE_CHARS + 50),
      })),
    ];
    const record = makeRecord(
      report({
        findings: [
          {
            severity: "HIGH",
            change: "added",
            capability: {
              kind: "NET",
              location: { kind: "runtime" },
              evidence,
            },
            previous: null,
          },
        ],
      }),
    );

    await publishFindings(record, findings, () => NOW);

    const [finding] = await findings.findByPackage(record.name, record.version);
    expect(finding?.evidence).toHaveLength(20);
    for (const ref of finding?.evidence ?? []) {
      expect(Number.isInteger(ref.line)).toBe(true);
      expect(ref.line).toBeGreaterThan(0);
      expect(Array.from(ref.file).length).toBeLessThanOrEqual(
        MAX_EVIDENCE_FILE_CHARS,
      );
      expect(Array.from(ref.excerpt).length).toBeLessThanOrEqual(
        MAX_VALUE_CHARS,
      );
    }
    expect(finding?.evidence[0]).toMatchObject({ line: 1 });
  });

  it("publishes findings from an incomplete record", async () => {
    const record = makeRecord(mixedReport(), {
      status: "incomplete",
      incompleteReasons: ["new-manifest: fetch-failed"],
    });

    const counts = await publishFindings(record, findings, () => NOW);

    expect(counts.created).toBe(4);
    await expect(findings.feedSince(0, 10)).resolves.toEqual({
      entries: [],
      lastSequence: 0,
    });
  });
});
