import { describe, expect, it } from "vitest";
import type { CapabilityDiffResult } from "./capability-differ.js";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import type { Capability } from "./contract/capability-set.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import {
  ReporterContractError,
  renderJsonReport,
  renderJsonRunReport,
  renderTextReport,
  renderTextRunReport,
} from "./reporter.js";
import { renderSarifReport } from "./sarif-reporter.js";

function emptyResult(): CapabilityDiffResult {
  return {
    baseline: {
      ecosystem: "npm",
      name: "fixture",
      version: "1.0.0",
    },
    subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
    newPackage: false,
    findings: [],
    diagnostics: [],
  };
}

function changedPackage(
  name = "fixture",
  oldVersion: string | null = "1.0.0",
): ChangedPackage {
  return {
    name,
    oldVersion,
    newVersion: "2.0.0",
    oldIntegrity: oldVersion === null ? null : "sha512-old",
    newIntegrity: "sha512-new",
    oldResolvedUrl:
      oldVersion === null ? null : `https://registry.npmjs.org/${name}/old.tgz`,
    resolvedUrl: `https://registry.npmjs.org/${name}/new.tgz`,
  };
}

function analyzedRun(): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
    packages: [
      {
        status: "analyzed",
        changedPackage: changedPackage(),
        diff: emptyResult(),
        issues: [],
      },
    ],
    lockfileFindings: [],
    skipped: [],
  };
}

describe("manifest Reporter", () => {
  it("renders escaped and bounded attacker-controlled strings in JSON and text", () => {
    const attacker = 'evil"\n<script>[x](javascript:alert(1))';
    const result: CapabilityDiffResult = {
      baseline: null,
      subject: { ecosystem: "npm", name: attacker, version: "2.0.0" },
      newPackage: true,
      findings: [
        {
          severity: "LOW",
          change: "added",
          capability: {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: attacker,
            requirement: `^1.0.0${"x".repeat(300)}`,
            evidence: [
              {
                file: attacker,
                line: 4,
                snippet: `${attacker}${"y".repeat(300)}`,
              },
            ],
          },
          previous: null,
        },
      ],
      diagnostics: [],
    };

    const json = renderJsonReport(result);
    const text = renderTextReport(result);

    expect(json).toContain('evil\\"\\n<script>');
    expect(text).toContain('evil\\"\\n<script>');
    expect(text).not.toContain('evil"\n<script>');
    const parsed = JSON.parse(json) as {
      findings: {
        capability: {
          requirement: string;
          evidence: { snippet: string }[];
        };
      }[];
    };
    expect(
      Array.from(parsed.findings[0]?.capability.requirement ?? ""),
    ).toHaveLength(240);
    expect(
      Array.from(parsed.findings[0]?.capability.evidence[0]?.snippet ?? ""),
    ).toHaveLength(240);
  });

  it("renders a stable no-findings report", () => {
    expect(renderTextReport(emptyResult())).toBe(
      [
        "capdelta manifest capability report",
        'Package: "fixture" ("npm") "1.0.0" -> "2.0.0"',
        "Review this change: no capability or signal additions; 0 diagnostics.",
        "",
      ].join("\n"),
    );
  });

  it("renders reviewer guidance under CRITICAL findings but not LOW ones", () => {
    const installHook: Capability = {
      kind: "INSTALL_HOOK",
      location: {
        kind: "install-script",
        hook: "postinstall",
        applicability: "registry-install",
      },
      contentDigest: { algorithm: "sha256", value: "a".repeat(64) },
      evidence: [{ file: "package.json", line: 5, snippet: '"postinstall"' }],
    };
    const critical: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "CRITICAL",
          change: "added",
          capability: installHook,
          previous: null,
        },
      ],
    };
    const criticalText = renderTextReport(critical);
    expect(criticalText).toContain(
      "  Why: Install hooks could run automatically during npm install",
    );
    expect(criticalText).toContain(
      "  Check: Check that the upstream repository",
    );

    const dependency: Capability = {
      kind: "DEPENDENCY",
      location: { kind: "manifest" },
      name: "dep",
      requirement: "^1.0.0",
      evidence: [{ file: "package.json", line: 3, snippet: '"dep": "^1.0.0"' }],
    };
    const low: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "LOW",
          change: "added",
          capability: dependency,
          previous: null,
        },
      ],
    };
    const lowText = renderTextReport(low);
    expect(lowText).toContain("[LOW]");
    expect(lowText).not.toContain("  Why: ");
    expect(lowText).not.toContain("  Check: ");
  });

  it("renders guidance for a CRITICAL signal and a severity-bearing analysis issue", () => {
    const signalResult: CapabilityDiffResult = {
      ...emptyResult(),
      signalFindings: [
        {
          kind: "new-external-endpoint",
          severity: "HIGH",
          change: "added",
          detail: "new external domain collector.example.test",
          evidence: [{ file: "index.js", line: 2, snippet: "fetch(url)" }],
        },
      ],
    };
    expect(renderTextReport(signalResult)).toContain(
      "  Why: The code now references a network host",
    );

    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("tampered"),
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "old",
                kind: "integrity-mismatch",
                detail:
                  "downloaded bytes do not match lockfile sha512 integrity",
                url: "https://registry.npmjs.org/tampered/old.tgz",
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const issueText = renderTextRunReport(run);
    expect(issueText).toContain("  Why: The downloaded bytes differ");
    expect(issueText).toContain(
      "  Check: Check where the lockfile entry and the registry response came from, and regenerate the lockfile from a trusted registry.",
    );
  });

  it("renders signal findings with their evidence and severity", () => {
    const result: CapabilityDiffResult = {
      ...emptyResult(),
      signalFindings: [
        {
          kind: "new-external-endpoint",
          severity: "HIGH",
          change: "added",
          detail: "new external domain evil.example",
          evidence: [
            {
              file: "lib/index.js",
              line: 4,
              snippet: "fetch('https://evil.example')",
            },
          ],
        },
      ],
    };

    expect(renderTextReport(result)).toContain(
      '[HIGH] "new external domain evil.example"',
    );
    expect(JSON.parse(renderJsonReport(result))).toMatchObject({
      summary: { findings: 1, capabilityFindings: 0, signalFindings: 1 },
      signalFindings: [{ kind: "new-external-endpoint", severity: "HIGH" }],
    });
  });

  it("throws for inconsistent findings and renders AST capabilities", () => {
    const inconsistent: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "LOW",
          change: "added",
          capability: {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: "dep",
            requirement: "1",
            evidence: [
              { file: "package.json", line: 1, snippet: '"dep": "1"' },
            ],
          },
          previous: {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: "dep",
            requirement: "0",
            evidence: [
              { file: "package.json", line: 1, snippet: '"dep": "0"' },
            ],
          },
        },
      ],
    };
    expect(() => renderJsonReport(inconsistent)).toThrow(ReporterContractError);

    const future: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "HIGH",
          change: "added",
          capability: {
            kind: "NET",
            location: { kind: "runtime" },
            evidence: [
              { file: "index.js", line: 1, snippet: 'fetch("example")' },
            ],
          },
          previous: null,
        },
      ],
    };
    expect(renderTextReport(future)).toContain(
      '[HIGH] "NET" capability added in "runtime" code',
    );
  });

  it("renders every loud run-level failure channel with escaped values", () => {
    const attacker = 'bad"\n<script>';
    const changed = changedPackage(attacker, null);
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 1 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changed,
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "http-status",
                detail: `HTTP 404 ${attacker}`,
                url: `https://registry.npmjs.org/${attacker}.tgz`,
              },
            },
          ],
        },
      ],
      lockfileFindings: [
        {
          kind: "version-downgrade",
          name: attacker,
          path: `node_modules/${attacker}`,
          oldVersion: "3.0.0",
          newVersion: "2.0.0",
        },
      ],
      skipped: [
        {
          name: attacker,
          path: `node_modules/${attacker}`,
          reason: "private-registry",
          detail: `private host ${attacker}`,
        },
      ],
    };

    const json = renderJsonRunReport(run);
    const text = renderTextRunReport(run);

    expect(json).toContain('bad\\"\\n<script>');
    expect(text).not.toContain('bad"\n<script>');
    expect(text).toContain("[fetch/http-status]");
    expect(text).toContain("Lockfile findings:");
    expect(text).toContain("Skipped lockfile entries:");
    expect(JSON.parse(json)).toMatchObject({
      summary: {
        unavailablePackages: 1,
        analysisIssues: 1,
        lockfileFindings: 1,
        skippedLockfileEntries: 1,
      },
      packages: [
        {
          status: "unavailable",
          failures: [{ stage: "fetch", side: "new", kind: "http-status" }],
        },
      ],
    });
  });

  it("reports whole-analysis cancellation without inventing a package side", () => {
    const changed = changedPackage("queued", null);
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changed,
          failures: [
            {
              stage: "analysis",
              failure: {
                kind: "deadline-exceeded",
                detail: "analysis wall-clock deadline exceeded",
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };

    expect(JSON.parse(renderJsonRunReport(run))).toMatchObject({
      schemaVersion: 5,
      packages: [
        {
          status: "unavailable",
          failures: [
            {
              stage: "analysis",
              side: null,
              kind: "deadline-exceeded",
            },
          ],
        },
      ],
    });
    expect(renderTextRunReport(run)).toContain(
      '[analysis/deadline-exceeded] "analysis wall-clock deadline exceeded"',
    );
  });

  it("cross-links new dependencies to every matching analyzed report", () => {
    const parent = emptyResult();
    parent.findings = [
      {
        severity: "LOW",
        change: "added",
        capability: {
          kind: "DEPENDENCY",
          location: { kind: "manifest" },
          name: "alias",
          targetName: "target",
          requirement: "npm:target@2.0.0",
          evidence: [
            {
              file: "package.json",
              line: 3,
              snippet: '"alias":"npm:target@2.0.0"',
            },
          ],
        },
        previous: null,
      },
    ];
    const target: CapabilityDiffResult = {
      ...emptyResult(),
      baseline: null,
      subject: { ecosystem: "npm", name: "target", version: "2.0.0" },
      newPackage: true,
    };
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 2, analyzed: 2, unavailable: 0, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: changedPackage(),
          diff: parent,
          issues: [],
        },
        {
          status: "analyzed",
          changedPackage: changedPackage("target", null),
          diff: target,
          issues: [],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const report = JSON.parse(renderJsonRunReport(run)) as {
      packages: [
        { report: { findings: [{ relatedReportIds: string[] }] } },
        { report: { reportId: string } },
      ];
    };
    expect(report.packages[0].report.findings[0].relatedReportIds).toEqual([
      report.packages[1].report.reportId,
    ]);
  });

  it("keeps first-run text aggregate-only while JSON retains package details", () => {
    const run = analyzedRun();
    run.firstRun = true;

    const text = renderTextRunReport(run);
    const json = renderJsonRunReport(run);

    expect(text).toBe(
      [
        "capdelta capability analysis report",
        "Mode: first run (aggregate text; full details are in JSON)",
        "Packages: 1 changed; 1 analyzed; 0 unavailable; 0 lockfile skips.",
        "Signals: 0 findings; 0 lockfile findings; 0 analysis issues; 0 analysis diagnostics.",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("Package:");
    expect(JSON.parse(json)).toMatchObject({
      firstRun: true,
      packages: [
        { status: "analyzed", report: { package: { name: "fixture" } } },
      ],
    });
  });

  it("renders non-fatal cleanup issues after a successful package report", () => {
    const run = analyzedRun();
    const analyzed = run.packages[0];
    if (analyzed?.status !== "analyzed") {
      throw new Error("inert fixture must be analyzed");
    }
    analyzed.issues = [
      {
        stage: "new-cleanup",
        failure: {
          kind: "cleanup-failed",
          detail: "cleanup failed: Error",
        },
      },
    ];

    expect(renderTextRunReport(run)).toContain(
      '[new-cleanup/cleanup-failed] "cleanup failed: Error"',
    );
    expect(JSON.parse(renderJsonRunReport(run))).toMatchObject({
      summary: { analyzedPackages: 1, analysisIssues: 1 },
      packages: [
        {
          status: "analyzed",
          issues: [{ stage: "new-cleanup", kind: "cleanup-failed" }],
        },
      ],
    });
  });

  it("rejects inconsistent run summaries and package identities", () => {
    const badSummary = analyzedRun();
    badSummary.summary.analyzed = 0;
    expect(() => renderJsonRunReport(badSummary)).toThrow(
      ReporterContractError,
    );

    const badIdentity = analyzedRun();
    const analyzed = badIdentity.packages[0];
    if (analyzed?.status !== "analyzed") {
      throw new Error("inert fixture must be analyzed");
    }
    analyzed.diff.subject.name = "different";
    expect(() => renderTextRunReport(badIdentity)).toThrow(
      ReporterContractError,
    );
  });
});

describe("run severity classification", () => {
  function severityRun(): CapabilityAnalysisRun {
    const installNet: Capability = {
      kind: "NET",
      location: {
        kind: "install-script",
        hook: "postinstall",
        applicability: "registry-install",
      },
      evidence: [{ file: "install.js", line: 2, snippet: 'require("https")' }],
    };
    const runtimeNet: Capability = {
      kind: "NET",
      location: { kind: "runtime" },
      evidence: [{ file: "index.js", line: 2, snippet: "fetch(url)" }],
    };
    const diff: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "MEDIUM",
          change: "added",
          capability: {
            kind: "FS_WRITE",
            location: { kind: "runtime" },
            evidence: [{ file: "index.js", line: 1, snippet: "writeFile()" }],
          },
          previous: null,
          suppression: { reason: "reviewed build helper" },
        },
        {
          severity: "CRITICAL",
          change: "added",
          capability: installNet,
          previous: null,
        },
        {
          severity: "HIGH",
          change: "added",
          capability: runtimeNet,
          previous: null,
        },
      ],
      signalFindings: [
        {
          kind: "new-external-endpoint",
          severity: "HIGH",
          change: "added",
          detail: "new external domain reviewed.example",
          evidence: [{ file: "index.js", line: 3, snippet: "reviewed" }],
          suppression: { reason: "first-party telemetry host" },
        },
        {
          kind: "entropy-jump",
          severity: "MEDIUM",
          change: "changed",
          detail: "entropy jump in index.js",
          evidence: [{ file: "index.js", line: 1, snippet: "index.js" }],
        },
      ],
      // The shape already raised its member to CRITICAL; the shape record
      // itself is not an extra gate finding.
      shapes: [
        {
          ruleId: "install-code-execution",
          severity: "CRITICAL",
          capabilities: [installNet],
        },
      ],
    };
    return {
      firstRun: false,
      summary: { changed: 4, analyzed: 1, unavailable: 3, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: changedPackage(),
          diff,
          issues: [
            {
              stage: "new-cleanup",
              failure: { kind: "cleanup-failed", detail: "cleanup failed" },
            },
          ],
        },
        {
          status: "unavailable",
          changedPackage: changedPackage("tampered"),
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "old",
                kind: "integrity-mismatch",
                detail:
                  "downloaded bytes do not match lockfile sha512 integrity",
                url: "https://registry.npmjs.org/tampered/old.tgz",
              },
            },
          ],
        },
        {
          status: "unavailable",
          changedPackage: changedPackage("tampered-new"),
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "integrity-mismatch",
                detail:
                  "downloaded bytes do not match lockfile sha512 integrity",
                url: "https://registry.npmjs.org/tampered-new/new.tgz",
              },
            },
            {
              stage: "new-cleanup",
              failure: { kind: "cleanup-failed", detail: "cleanup failed" },
            },
          ],
        },
        {
          status: "unavailable",
          changedPackage: changedPackage("missing"),
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "http-status",
                detail: "HTTP 404",
                url: "https://registry.npmjs.org/missing/new.tgz",
              },
            },
          ],
        },
      ],
      lockfileFindings: [
        {
          kind: "integrity-changed-version-same",
          name: "repacked",
          path: "node_modules/repacked",
          oldVersion: "1.0.0",
          newVersion: "1.0.0",
        },
        {
          kind: "version-downgrade",
          name: "older",
          path: "node_modules/older",
          oldVersion: "2.0.0",
          newVersion: "1.0.0",
        },
      ],
      skipped: [],
    };
  }

  it("counts each gate-bearing record once and keeps bySeverity semantics", () => {
    const report = JSON.parse(renderJsonRunReport(severityRun())) as {
      summary: Record<string, unknown>;
      packages: { status: string; issues?: unknown[]; failures?: unknown[] }[];
      lockfileFindings: { severity: string }[];
    };

    expect(report.summary).toMatchObject({
      // All capability/signal findings, suppressed included.
      bySeverity: { CRITICAL: 1, HIGH: 2, MEDIUM: 2, LOW: 0, INFO: 0 },
      // Unsuppressed findings + lockfile findings + unavailable packages'
      // severity issues. One CRITICAL finding + one per integrity mismatch,
      // either side, + one for the now-CRITICAL non-retryable HTTP status
      // (ADR-018); the cleanup failure sharing a failures array adds nothing.
      gateSeverity: { CRITICAL: 4, HIGH: 2, MEDIUM: 1, LOW: 0, INFO: 1 },
    });
    expect(report.packages.map((item) => item.issues ?? item.failures)).toEqual(
      [
        [expect.objectContaining({ kind: "cleanup-failed", severity: null })],
        [
          expect.objectContaining({
            kind: "integrity-mismatch",
            side: "old",
            severity: "CRITICAL",
          }),
        ],
        [
          expect.objectContaining({
            kind: "integrity-mismatch",
            side: "new",
            severity: "CRITICAL",
          }),
          expect.objectContaining({ kind: "cleanup-failed", severity: null }),
        ],
        [
          expect.objectContaining({
            kind: "http-status",
            severity: "CRITICAL",
          }),
        ],
      ],
    );
    expect(report.lockfileFindings.map((finding) => finding.severity)).toEqual([
      "HIGH",
      "INFO",
    ]);
  });

  it("renders gate severities in comparison and first-run text", () => {
    const text = renderTextRunReport(severityRun());
    expect(text).toContain(
      "Gate severity: CRITICAL: 4, HIGH: 2, MEDIUM: 1, INFO: 1.",
    );
    expect(text).toContain(
      '- [CRITICAL] [fetch/integrity-mismatch] "downloaded bytes do not match lockfile sha512 integrity"',
    );
    expect(text).toContain(
      '- [CRITICAL] could not analyze: [fetch/http-status] "HTTP 404"',
    );
    expect(text).toContain(
      '- [HIGH] [integrity-changed-version-same] "repacked"',
    );
    expect(text).toContain(`suppressed ("reviewed build helper")`);

    const firstRun = severityRun();
    firstRun.firstRun = true;
    expect(renderTextRunReport(firstRun)).toContain(
      "Gate severity: CRITICAL: 4, HIGH: 2, MEDIUM: 1, INFO: 1.",
    );
  });

  it("omits the gate line when nothing can gate", () => {
    expect(renderTextRunReport(analyzedRun())).not.toContain("Gate severity");
  });

  it("counts an unavailable package once at its highest failure severity", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("oversized"),
          failures: [
            {
              stage: "new-extraction",
              failure: { kind: "file-count-limit", detail: "too many files" },
            },
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "size-limit-exceeded",
                detail: "tarball over the fetch cap",
                url: "https://registry.npmjs.org/oversized/new.tgz",
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const report = JSON.parse(renderJsonRunReport(run)) as {
      summary: { analysisIssues: number; gateSeverity: Record<string, number> };
      packages: { failures: { severity: string | null }[] }[];
    };
    expect(report.summary.analysisIssues).toBe(2);
    expect(report.summary.gateSeverity.CRITICAL).toBe(1);
    expect(
      report.packages[0]?.failures.map((failure) => failure.severity),
    ).toEqual(["CRITICAL", "CRITICAL"]);
  });

  it("labels unanalyzable issues could not analyze without touching mismatches", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("oversized"),
          failures: [
            {
              stage: "new-extraction",
              failure: { kind: "file-count-limit", detail: "too many files" },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    expect(renderTextRunReport(run)).toContain(
      '[CRITICAL] could not analyze: [new-extraction/file-count-limit] "too many files"',
    );

    // An integrity mismatch is CRITICAL without being unanalyzable: its own
    // line keeps its wording and carries no "could not analyze" label even
    // though another package's HTTP status now does.
    const mismatch = renderTextRunReport(severityRun());
    expect(mismatch).toContain(
      '- [CRITICAL] [fetch/integrity-mismatch] "downloaded bytes do not match lockfile sha512 integrity"',
    );
    const mismatchLines = mismatch
      .split("\n")
      .filter((line) => line.includes("[fetch/integrity-mismatch]"));
    expect(mismatchLines.length).toBeGreaterThan(0);
    expect(
      mismatchLines.every((line) => !line.includes("could not analyze")),
    ).toBe(true);
  });

  it("keeps an unavailable package at a gate count of 0 without a severity", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("flaky"),
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "network-error",
                detail: "connection reset",
                url: "https://registry.npmjs.org/flaky/new.tgz",
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const report = JSON.parse(renderJsonRunReport(run)) as {
      summary: { gateSeverity: Record<string, number> };
    };
    expect(report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(renderTextRunReport(run)).not.toContain("Gate severity");
  });

  it("renders no guidance for a null-severity operational issue (ADR-019)", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("unreadable"),
          failures: [
            {
              stage: "new-extraction",
              failure: {
                kind: "filesystem-error",
                detail: "extraction failed and cleanup failed",
              },
            },
            {
              stage: "new-manifest",
              failure: {
                kind: "manifest-unreadable",
                detail: "package.json could not be read",
                evidence: null,
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const report = JSON.parse(renderJsonRunReport(run)) as {
      summary: { gateSeverity: Record<string, number>; analysisIssues: number };
    };
    // ADR-019: operational, but still severity-null, so the gate does not move.
    expect(report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(report.summary.analysisIssues).toBe(2);
    const text = renderTextRunReport(run);
    expect(text).toContain(
      '- [new-extraction/filesystem-error] "extraction failed and cleanup failed"',
    );
    expect(text).toContain(
      '- [new-manifest/manifest-unreadable] "package.json could not be read"',
    );
    expect(text).not.toContain("Why:");
    expect(text).not.toContain("Check:");
    // ADR-019 consequence: a null-severity issue renders no SARIF result.
    const sarif = JSON.parse(renderSarifReport(run)) as {
      runs: { results: unknown[] }[];
    };
    expect(sarif.runs[0]?.results).toEqual([]);
  });

  it("releases a reviewed exception from the gate but keeps its issues", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("oversized"),
          failures: [
            {
              stage: "new-extraction",
              failure: { kind: "file-count-limit", detail: "too many files" },
            },
          ],
          exception: { reason: "[version 2.0.0] reviewed oversized fixture" },
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const report = JSON.parse(renderJsonRunReport(run)) as {
      summary: { analysisIssues: number; gateSeverity: Record<string, number> };
      packages: {
        exception?: { reason: string };
        failures: { severity: string | null }[];
      }[];
    };
    // ADR-017: the exception releases the gate; the failures stay loud.
    expect(report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(report.summary.analysisIssues).toBe(1);
    expect(report.packages[0]?.exception).toEqual({
      reason: "[version 2.0.0] reviewed oversized fixture",
    });
    expect(report.packages[0]?.failures[0]?.severity).toBe("CRITICAL");
    expect(renderTextRunReport(run)).toContain(
      'reviewed exception: "[version 2.0.0] reviewed oversized fixture"',
    );
    const text = renderTextRunReport(run);
    expect(text).toContain(
      "could not analyze: [new-extraction/file-count-limit]",
    );
  });

  it("bounds a reviewed exception reason like every other report value", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changedPackage("oversized"),
          failures: [
            {
              stage: "new-extraction",
              failure: { kind: "file-count-limit", detail: "too many files" },
            },
          ],
          exception: { reason: `[version 2.0.0] ${"x".repeat(400)}` },
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const report = JSON.parse(renderJsonRunReport(run)) as {
      packages: { exception?: { reason: string } }[];
    };
    expect(
      Array.from(report.packages[0]?.exception?.reason ?? ""),
    ).toHaveLength(240);
  });
});
