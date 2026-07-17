import { describe, expect, it } from "vitest";
import type { CapabilityDiffResult } from "./capability-differ.js";
import type { ManifestAnalysisRun } from "./manifest-analysis-pipeline.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import {
  ReporterContractError,
  renderJsonReport,
  renderJsonRunReport,
  renderTextReport,
  renderTextRunReport,
} from "./reporter.js";

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

function analyzedRun(): ManifestAnalysisRun {
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
        "Review this change: no manifest capability additions; 0 diagnostics.",
        "",
      ].join("\n"),
    );
  });

  it("throws for inconsistent findings and unsupported future capabilities", () => {
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
    expect(() => renderTextReport(future)).toThrow(ReporterContractError);
  });

  it("renders every loud run-level failure channel with escaped values", () => {
    const attacker = 'bad"\n<script>';
    const changed = changedPackage(attacker, null);
    const run: ManifestAnalysisRun = {
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

  it("keeps first-run text aggregate-only while JSON retains package details", () => {
    const run = analyzedRun();
    run.firstRun = true;

    const text = renderTextRunReport(run);
    const json = renderJsonRunReport(run);

    expect(text).toBe(
      [
        "capdelta manifest analysis report",
        "Mode: first run (aggregate text; full details are in JSON)",
        "Packages: 1 changed; 1 analyzed; 0 unavailable; 0 lockfile skips.",
        "Signals: 0 manifest findings; 0 lockfile findings; 0 analysis issues; 0 manifest diagnostics.",
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
