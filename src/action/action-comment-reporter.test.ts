import { describe, expect, it, vi } from "vitest";
import type { JsonRunReport } from "../core/reporter.js";
import {
  ActionCommentApiError,
  ActionCommentContractError,
  COMMENT_MARKER,
  escapeMarkdownText,
  publishStickyComment,
  renderActionComment,
  type GitHubCommentClient,
} from "./action-comment-reporter.js";

const PAYLOAD =
  "</td></tr><script>alert(1)</script>\n| [click](javascript:alert(1)) ![x](https://evil.example) <!-- capdelta:manifest-report:v1 --> `code` @everyone\u001b\u202e";

function adversarialReport(firstRun = false): JsonRunReport {
  return {
    schemaVersion: 2,
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
    },
    packages: [
      {
        status: "analyzed",
        report: {
          schemaVersion: 2,
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
          },
        ],
      },
    ],
    lockfileFindings: [],
    skipped: [],
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

    expect(body.match(/<!-- capdelta:manifest-report:v1 -->/gu)).toHaveLength(
      1,
    );
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

  it("uses explicit aggregate framing for first-run mode", () => {
    expect(renderActionComment(adversarialReport(true))).toContain(
      "**First run:** no base lockfile was found.",
    );
  });

  it("reduces rows rather than slicing Markdown to honor the cap", () => {
    const report = adversarialReport();
    const withoutRows = renderActionComment(report, {
      maxCharacters: 2_000,
      maxRows: 0,
    });
    const body = renderActionComment(report, {
      maxCharacters: Array.from(withoutRows).length,
      maxRows: 10,
    });
    expect(body).toBe(withoutRows);
    expect(body).toContain("Showing 0 of 1 capability findings");
    expect(body.endsWith("\n")).toBe(true);
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
      { id: 3, body: COMMENT_MARKER, authorLogin: "github-actions[bot]" },
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
