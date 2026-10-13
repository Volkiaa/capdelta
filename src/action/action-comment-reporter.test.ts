import { describe, expect, it, vi } from "vitest";
import type { JsonRunReport } from "../core/reporter.js";
import {
  ANALYSIS_ISSUE_GUIDANCE,
  CAPABILITY_GUIDANCE,
  SHAPE_GUIDANCE,
  SIGNAL_GUIDANCE,
} from "../core/finding-guidance.js";
import {
  ActionCommentApiError,
  ActionCommentContractError,
  COMMENT_MARKER,
  MAX_GUIDANCE_CHARS,
  escapeMarkdownText,
  publishStickyComment,
  renderActionComment,
  type GitHubCommentClient,
} from "./action-comment-reporter.js";

const PAYLOAD =
  "</td></tr><script>alert(1)</script>\n| [click](javascript:alert(1)) ![x](https://evil.example) <!-- capdelta:manifest-report:v1 --> `code` @everyone\u001b\u202e";

function adversarialReport(firstRun = false): JsonRunReport {
  return {
    schemaVersion: 5,
    firstRun,
    summary: {
      changedPackages: 1,
      analyzedPackages: 1,
      unavailablePackages: 0,
      skippedLockfileEntries: 0,
      capabilityFindings: 1,
      analysisDiagnostics: 0,
      analysisIssues: 1,
      lockfileFindings: 0,
      bySeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      gateSeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    },
    packages: [
      {
        status: "analyzed",
        report: {
          schemaVersion: 5,
          package: {
            ecosystem: "npm",
            name: PAYLOAD,
            oldVersion: "1.0.0",
            newVersion: "2.0.0",
            newPackage: false,
          },
          summary: {
            findings: 1,
            diagnostics: 0,
            bySeverity: {
              CRITICAL: 1,
              HIGH: 0,
              MEDIUM: 0,
              LOW: 0,
              INFO: 0,
            },
          },
          findings: [
            {
              severity: "CRITICAL",
              change: "added",
              capability: {
                kind: "INSTALL_HOOK",
                hook: "postinstall",
                applicability: "registry-install",
                contentDigest: { algorithm: "sha256", value: "a".repeat(64) },
                evidence: [{ file: PAYLOAD, line: 1, snippet: PAYLOAD }],
              },
              previous: null,
            },
          ],
          diagnostics: [],
        },
        issues: [
          {
            stage: "fetch",
            side: "new",
            kind: "network-error",
            detail: PAYLOAD,
            url: `javascript:${PAYLOAD}`,
            evidence: null,
            severity: null,
          },
        ],
      },
    ],
    lockfileFindings: [],
    skipped: [],
  };
}

/**
 * A report with one LOW finding row and one fetch-stage analysis-gap row. The
 * guidance-free twin carries identical rows but a null-severity issue, so its
 * render is exactly the no-guidance base comment the row budget is decided on.
 */
function capSizingReports(): {
  report: JsonRunReport;
  guidanceFree: JsonRunReport;
} {
  const base = adversarialReport();
  const analyzed = base.packages[0];
  if (analyzed?.status !== "analyzed") {
    throw new Error("fixture must contain an analyzed package");
  }
  const report = {
    ...analyzed.report,
    findings: [
      {
        severity: "LOW" as const,
        change: "added" as const,
        capability: {
          kind: "DEPENDENCY" as const,
          name: "dep",
          requirement: "^1.0.0",
          evidence: [{ file: "package.json", line: 3, snippet: '"dep"' }],
        },
        previous: null,
      },
    ],
    summary: {
      ...analyzed.report.summary,
      findings: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1, INFO: 0 },
    },
  };
  const issue = (severity: "CRITICAL" | null) => ({
    stage: "fetch" as const,
    side: "new" as const,
    kind: "integrity-mismatch" as const,
    detail: "integrity mismatch for the new artifact",
    url: "https://registry.npmjs.org/dep.tgz",
    evidence: null,
    severity,
  });
  const summary = {
    ...base.summary,
    capabilityFindings: 1,
    analysisIssues: 1,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1, INFO: 0 },
    gateSeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  };
  return {
    report: {
      ...base,
      summary,
      packages: [{ ...analyzed, report, issues: [issue("CRITICAL")] }],
    },
    guidanceFree: {
      ...base,
      summary,
      packages: [{ ...analyzed, report, issues: [issue(null)] }],
    },
  };
}

function commentClient() {
  return {
    listComments: vi
      .fn<GitHubCommentClient["listComments"]>()
      .mockResolvedValue([]),
    createComment: vi
      .fn<GitHubCommentClient["createComment"]>()
      .mockResolvedValue({ id: 12 }),
    updateComment: vi
      .fn<GitHubCommentClient["updateComment"]>()
      .mockResolvedValue(undefined),
  };
}

describe("renderActionComment", () => {
  it("renders package, script evidence, and URLs as inert bounded text", () => {
    const body = renderActionComment(adversarialReport(), {
      artifactName: PAYLOAD,
    });

    expect(body.match(/<!-- capdelta:/gu)).toHaveLength(1);
    expect(body.startsWith(`${COMMENT_MARKER}\n`)).toBe(true);
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("[click]");
    expect(body).not.toContain("`code`");
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("\u202e");
    expect(body).toContain("&#60;&#47;td&#62;");
    expect(body).toContain("&#92;u001b");
    expect(Array.from(body).length).toBeLessThanOrEqual(60_000);
  });

  it("deduplicates guidance by class and keeps the size cap", () => {
    const first = adversarialReport();
    const analyzed = first.packages[0];
    if (analyzed?.status !== "analyzed") {
      throw new Error("fixture must contain an analyzed package");
    }
    const second = {
      ...analyzed,
      report: {
        ...analyzed.report,
        package: { ...analyzed.report.package, name: "second-package" },
      },
    };
    const report: JsonRunReport = {
      ...first,
      summary: {
        ...first.summary,
        changedPackages: 2,
        analyzedPackages: 2,
        capabilityFindings: 2,
      },
      packages: [analyzed, second],
    };

    const body = renderActionComment(report);
    expect(body.match(/### What these mean/gu)).toHaveLength(1);
    // Two CRITICAL install-hook findings of the same class share one entry.
    expect(body.match(/\*\*INSTALL&#95;HOOK\*\*/gu)).toHaveLength(1);
    expect(body).not.toContain("was omitted");
    expect(Array.from(body).length).toBeLessThanOrEqual(60_000);
  });

  it("truncates guidance with the overflow footer when the cap is tight", () => {
    const report = adversarialReport();
    const full = renderActionComment(report, { maxRows: 0 });
    const tight = renderActionComment(report, {
      maxCharacters: Array.from(full).length - 1,
      maxRows: 0,
    });
    expect(tight).not.toContain("### What these mean");
    expect(tight).toContain("Guidance for 1 class was omitted");
    expect(tight).toContain("SARIF rule help");
    expect(Array.from(tight).length).toBeLessThanOrEqual(
      Array.from(full).length - 1,
    );
  });

  it("keeps every finding row when only the guidance list must be cut", () => {
    const report = adversarialReport();
    const analyzed = report.packages[0];
    if (analyzed?.status !== "analyzed") {
      throw new Error("fixture must contain an analyzed package");
    }
    const installHook = analyzed.report.findings[0];
    if (installHook === undefined) {
      throw new Error("fixture must contain an install-hook finding");
    }
    analyzed.report.findings = [
      installHook,
      {
        severity: "CRITICAL",
        change: "added",
        capability: {
          kind: "NET",
          location: {
            kind: "install-script",
            hook: "postinstall",
            applicability: "registry-install",
          },
          evidence: [{ file: "install.js", line: 2, snippet: "fetch(url)" }],
        },
        previous: null,
      },
    ];
    analyzed.report.summary = {
      ...analyzed.report.summary,
      findings: 2,
      bySeverity: { CRITICAL: 2, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    };
    report.summary = {
      ...report.summary,
      capabilityFindings: 2,
      bySeverity: { CRITICAL: 2, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    };

    const full = renderActionComment(report, { maxRows: 10 });
    // One character below the full comment: all rows fit, guidance must shrink.
    const truncated = renderActionComment(report, {
      maxCharacters: Array.from(full).length - 1,
      maxRows: 10,
    });

    expect(truncated).toContain("Showing 2 of 2 findings");
    expect(truncated).toContain("postinstall install hook");
    expect(truncated).toContain("added NET capability");
    expect(truncated).toContain("### What these mean");
    expect(truncated).toContain("was omitted");
    expect(Array.from(truncated).length).toBeLessThanOrEqual(
      Array.from(full).length - 1,
    );
  });

  it("keeps every row and omits all guidance at the exact no-guidance cap", () => {
    const { report, guidanceFree } = capSizingReports();
    const baseBody = renderActionComment(guidanceFree, { maxRows: 10 });
    const baseLength = Array.from(baseBody).length;

    const body = renderActionComment(report, {
      maxCharacters: baseLength,
      maxRows: 10,
    });

    // Exactly the pre-guidance body: every row, no section, no notice, no throw.
    expect(body).toBe(baseBody);
    expect(Array.from(body).length).toBe(baseLength);
    expect(body).toContain("added dependency dep");
    expect(body).toContain("integrity mismatch for the new artifact");
    expect(body).not.toContain("### What these mean");
    expect(body).not.toContain("was omitted");
  });

  it("keeps rows and drops the omission notice when only a few chars more fit", () => {
    const { report, guidanceFree } = capSizingReports();
    const baseBody = renderActionComment(guidanceFree, { maxRows: 10 });
    const baseLength = Array.from(baseBody).length;

    const body = renderActionComment(report, {
      maxCharacters: baseLength + 5,
      maxRows: 10,
    });

    expect(body).toBe(baseBody);
    expect(body).toContain("added dependency dep");
    expect(body).toContain("integrity mismatch for the new artifact");
    expect(body).not.toContain("### What these mean");
    expect(body).not.toContain("was omitted");
  });

  it("never exceeds maxCharacters on any path that returns a body", () => {
    const { report, guidanceFree } = capSizingReports();
    // The no-guidance, no-row body is the shortest satisfiable path, so every
    // cap from here on is satisfiable on every row budget.
    const floor = Array.from(
      renderActionComment(guidanceFree, { maxRows: 0 }),
    ).length;
    for (
      let maxCharacters = floor;
      maxCharacters <= floor + 5_000;
      maxCharacters += 97
    ) {
      for (const maxRows of [0, 1, 10]) {
        const body = renderActionComment(report, { maxCharacters, maxRows });
        expect(Array.from(body).length).toBeLessThanOrEqual(maxCharacters);
      }
    }
  });

  it("sizes the guidance cap above the longest guidance string", () => {
    const longest = [
      ...Object.values(SHAPE_GUIDANCE),
      ...Object.values(CAPABILITY_GUIDANCE),
      ...Object.values(SIGNAL_GUIDANCE),
      ...Object.values(ANALYSIS_ISSUE_GUIDANCE),
    ]
      .map((guidance) =>
        escapeMarkdownText(
          `${guidance.whyItMatters} ${guidance.whatToCheck}`,
          Number.MAX_SAFE_INTEGER,
        ),
      )
      .reduce((max, text) => Math.max(max, Array.from(text).length), 0);
    expect(longest).toBeGreaterThan(0);
    expect(MAX_GUIDANCE_CHARS).toBeGreaterThan(longest);
  });

  it("omits the guidance section when no CRITICAL or HIGH class is present", () => {
    const report = adversarialReport();
    const analyzed = report.packages[0];
    if (analyzed?.status !== "analyzed") {
      throw new Error("fixture must contain an analyzed package");
    }
    analyzed.report.findings = [
      {
        severity: "LOW",
        change: "added",
        capability: {
          kind: "DEPENDENCY",
          name: "dep",
          requirement: "^1.0.0",
          evidence: [{ file: "package.json", line: 3, snippet: '"dep"' }],
        },
        previous: null,
      },
    ];
    analyzed.report.summary = {
      ...analyzed.report.summary,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1, INFO: 0 },
    };
    const body = renderActionComment(report);
    expect(body).not.toContain("### What these mean");
  });

  it("labels unanalyzable issues in the analysis gaps table", () => {
    const report = adversarialReport();
    report.summary = {
      ...report.summary,
      changedPackages: 1,
      analyzedPackages: 0,
      unavailablePackages: 1,
      capabilityFindings: 0,
      analysisIssues: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      gateSeverity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    };
    report.packages = [
      {
        status: "unavailable",
        package: {
          ecosystem: "npm",
          name: "oversized",
          oldVersion: "1.0.0",
          newVersion: "2.0.0",
          newPackage: false,
        },
        failures: [
          {
            stage: "new-extraction",
            side: "new",
            kind: "expanded-size-limit",
            detail: "expanded size over the extraction cap",
            url: null,
            evidence: null,
            severity: "CRITICAL",
          },
        ],
      },
    ];

    const body = renderActionComment(report);
    expect(body).toContain("could not analyze&#58; new&#45;extraction");
    // Capability findings and integrity mismatches keep their own wording.
    expect(body).not.toContain("could not analyze&#58; new&#45;cleanup");
  });

  it("shows a reviewed exception for an unavailable package (ADR-017)", () => {
    const report = adversarialReport();
    report.summary = {
      ...report.summary,
      changedPackages: 1,
      analyzedPackages: 0,
      unavailablePackages: 1,
      capabilityFindings: 0,
      analysisIssues: 1,
      bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
      gateSeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
    };
    report.packages = [
      {
        status: "unavailable",
        package: {
          ecosystem: "npm",
          name: "oversized",
          oldVersion: "1.0.0",
          newVersion: "2.0.0",
          newPackage: false,
        },
        failures: [
          {
            stage: "new-extraction",
            side: "new",
            kind: "expanded-size-limit",
            detail: "expanded size over the extraction cap",
            url: null,
            evidence: null,
            severity: "CRITICAL",
          },
        ],
        exception: { reason: "[version 2.0.0] reviewed oversized fixture" },
      },
    ];

    const body = renderActionComment(report);
    expect(body).toContain("### Reviewed exceptions");
    expect(body).toContain("reviewed exception:");
    expect(body).toContain("reviewed oversized fixture");
  });

  it("uses explicit aggregate framing for first-run mode", () => {
    expect(renderActionComment(adversarialReport(true))).toContain(
      "**First run:** no base lockfile was found.",
    );
  });

  it("reduces rows rather than slicing Markdown once guidance is gone", () => {
    const report = adversarialReport();
    const rowFree = renderActionComment(report, { maxRows: 0 });
    // One below the row-free body drops the guidance section, leaving the
    // fixed floor the row loop reduces to.
    const floor = renderActionComment(report, {
      maxCharacters: Array.from(rowFree).length - 1,
      maxRows: 0,
    });
    const body = renderActionComment(report, {
      maxCharacters: Array.from(floor).length,
      maxRows: 10,
    });
    expect(body).toBe(floor);
    expect(body).toContain("Showing 0 of 1 findings");
    expect(body.endsWith("\n")).toBe(true);
  });

  it("keeps critical findings visible when lower priorities reach the row cap", () => {
    const report = adversarialReport();
    const criticalPackage = report.packages[0];
    if (criticalPackage?.status !== "analyzed") {
      throw new Error("fixture must contain an analyzed critical package");
    }
    const infoPackage: JsonRunReport["packages"][number] = {
      status: "analyzed",
      report: {
        ...criticalPackage.report,
        package: {
          ...criticalPackage.report.package,
          name: "alphabetically-first-info",
        },
        summary: {
          findings: 1,
          diagnostics: 0,
          bySeverity: {
            CRITICAL: 0,
            HIGH: 0,
            MEDIUM: 0,
            LOW: 0,
            INFO: 1,
          },
        },
        findings: [
          {
            severity: "INFO",
            change: "added",
            capability: {
              kind: "RUNTIME_CONSTRAINT",
              runtime: "node",
              requirement: ">=20",
              evidence: [
                {
                  file: "package.json",
                  line: 1,
                  snippet: '"node": ">=20"',
                },
              ],
            },
            previous: null,
          },
        ],
        shapes: [],
        diagnostics: [],
      },
      issues: [],
    };
    const body = renderActionComment(
      {
        ...report,
        summary: {
          ...report.summary,
          changedPackages: 2,
          analyzedPackages: 2,
          capabilityFindings: 2,
          bySeverity: {
            CRITICAL: 1,
            HIGH: 0,
            MEDIUM: 0,
            LOW: 0,
            INFO: 1,
          },
          gateSeverity: {
            CRITICAL: 1,
            HIGH: 0,
            MEDIUM: 0,
            LOW: 0,
            INFO: 1,
          },
        },
        packages: [infoPackage, criticalPackage],
      },
      { maxRows: 1 },
    );

    expect(body).toContain("| CRITICAL |");
    expect(body).toContain("postinstall");
    expect(body).not.toContain("| INFO |");
  });

  it("fails loudly when even the fixed summary cannot fit", () => {
    expect(() =>
      renderActionComment(adversarialReport(), { maxCharacters: 10 }),
    ).toThrow(ActionCommentContractError);
  });

  it("escapes markdown punctuation and invisible controls directly", () => {
    expect(escapeMarkdownText("a|<b>\n\u200b", 20)).toBe(
      "a&#124;&#60;b&#62;&#92;u000a&#92;u200b",
    );
  });
});

describe("publishStickyComment", () => {
  const baseDelivery = {
    owner: "owner",
    repo: "repo",
    issueNumber: 7,
    body: `${COMMENT_MARKER}\nbody`,
    readOnlyReason: null,
    addJobSummary: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
  } as const;

  it("creates a comment when no bot-owned marker exists", async () => {
    const client = commentClient();
    client.listComments.mockResolvedValueOnce([
      { id: 2, body: COMMENT_MARKER, authorLogin: "attacker" },
    ]);
    await expect(publishStickyComment(baseDelivery, client)).resolves.toEqual({
      status: "created",
      commentId: 12,
    });
    expect(client.updateComment).not.toHaveBeenCalled();
  });

  it("updates the newest bot-owned marker and warns about duplicates", async () => {
    const client = commentClient();
    client.listComments.mockResolvedValueOnce([
      {
        id: 3,
        body: "<!-- capdelta:manifest-report:v1 -->",
        authorLogin: "github-actions[bot]",
      },
      { id: 8, body: COMMENT_MARKER, authorLogin: "github-actions[bot]" },
    ]);
    const warn = vi.fn();
    await expect(
      publishStickyComment({ ...baseDelivery, warn }, client),
    ).resolves.toEqual({ status: "updated", commentId: 8 });
    expect(warn).toHaveBeenCalledOnce();
    expect(client.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 8 }),
    );
  });

  it.each(["fork", "dependabot"] as const)(
    "degrades %s PRs to the job summary without calling the API",
    async (reason) => {
      const client = commentClient();
      const addJobSummary = vi.fn().mockResolvedValue(undefined);
      await expect(
        publishStickyComment(
          { ...baseDelivery, readOnlyReason: reason, addJobSummary },
          client,
        ),
      ).resolves.toEqual({ status: "summary-only", reason });
      expect(addJobSummary).toHaveBeenCalledWith(baseDelivery.body);
      expect(client.listComments).not.toHaveBeenCalled();
    },
  );

  it("rethrows summary and comment API failures with operation context", async () => {
    const client = commentClient();
    client.listComments.mockRejectedValueOnce(new Error("offline"));
    await expect(publishStickyComment(baseDelivery, client)).rejects.toThrow(
      ActionCommentApiError,
    );

    await expect(
      publishStickyComment(
        {
          ...baseDelivery,
          readOnlyReason: "fork",
          addJobSummary: vi.fn().mockRejectedValue(new Error("summary failed")),
        },
        commentClient(),
      ),
    ).rejects.toThrow("failed to write the read-only PR job summary");
  });
});
