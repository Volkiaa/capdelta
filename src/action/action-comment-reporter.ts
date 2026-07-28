import type {
  JsonReportAnalysisIssue,
  JsonReportFinding,
  JsonRunReport,
} from "../core/reporter.js";
import { assessRunSeverity } from "./severity-gate.js";

export const COMMENT_MARKER = "<!-- capdelta:manifest-report:v1 -->";
const DEFAULT_MAX_COMMENT_CHARS = 60_000;
const DEFAULT_MAX_ROWS = 10;
const MAX_IDENTITY_CHARS = 120;
const MAX_DETAIL_CHARS = 200;

export interface ActionCommentOptions {
  artifactName?: string;
  maxCharacters?: number;
  maxRows?: number;
}

export interface GitHubComment {
  id: number;
  body: string | null;
  authorLogin: string | null;
}

export interface GitHubCommentClient {
  listComments(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    page: number;
    perPage: number;
  }): Promise<readonly GitHubComment[]>;
  createComment(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
  updateComment(input: {
    owner: string;
    repo: string;
    commentId: number;
    body: string;
  }): Promise<void>;
}

export interface CommentDelivery {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  readOnlyReason: "fork" | "dependabot" | null;
  addJobSummary(body: string): Promise<void>;
  warn(message: string): void;
}

export type CommentPublishResult =
  | { status: "created"; commentId: number }
  | { status: "updated"; commentId: number }
  | { status: "summary-only"; reason: "fork" | "dependabot" };

export class ActionCommentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ActionCommentConfigurationError extends ActionCommentError {}

export class ActionCommentContractError extends ActionCommentError {}

export class ActionCommentApiError extends ActionCommentError {}

/** Render a deterministic, summary-only Markdown comment (PLAN §4.5). */
export function renderActionComment(
  report: JsonRunReport,
  options: ActionCommentOptions = {},
): string {
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_COMMENT_CHARS;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const artifactName = options.artifactName ?? "capdelta-report.json";
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
    throw new ActionCommentConfigurationError(
      "maxCharacters must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
    throw new ActionCommentConfigurationError(
      "maxRows must be a non-negative safe integer",
    );
  }

  for (let rows = maxRows; rows >= 0; rows -= 1) {
    const body = buildComment(report, artifactName, rows);
    if (Array.from(body).length <= maxCharacters) return body;
  }
  throw new ActionCommentContractError(
    "fixed action-comment summary exceeds the configured size cap",
  );
}

/** Update the bot's sticky comment, or degrade to a job summary for read-only PRs. */
export async function publishStickyComment(
  delivery: CommentDelivery,
  client: GitHubCommentClient,
): Promise<CommentPublishResult> {
  validateDelivery(delivery);
  if (delivery.readOnlyReason !== null) {
    try {
      await delivery.addJobSummary(delivery.body);
    } catch (error: unknown) {
      throw new ActionCommentApiError(
        "failed to write the read-only PR job summary",
        { cause: error },
      );
    }
    return { status: "summary-only", reason: delivery.readOnlyReason };
  }

  const matches: GitHubComment[] = [];
  for (let page = 1; ; page += 1) {
    let comments: readonly GitHubComment[];
    try {
      comments = await client.listComments({
        owner: delivery.owner,
        repo: delivery.repo,
        issueNumber: delivery.issueNumber,
        page,
        perPage: 100,
      });
    } catch (error: unknown) {
      throw new ActionCommentApiError("failed to list PR comments", {
        cause: error,
      });
    }
    matches.push(
      ...comments.filter(
        (comment) =>
          comment.authorLogin === "github-actions[bot]" &&
          comment.body?.includes(COMMENT_MARKER) === true,
      ),
    );
    if (comments.length < 100) break;
  }

  if (matches.length === 0) {
    try {
      const created = await client.createComment({
        owner: delivery.owner,
        repo: delivery.repo,
        issueNumber: delivery.issueNumber,
        body: delivery.body,
      });
      return { status: "created", commentId: created.id };
    } catch (error: unknown) {
      throw new ActionCommentApiError("failed to create the PR comment", {
        cause: error,
      });
    }
  }

  const target = [...matches].sort((a, b) => b.id - a.id)[0];
  if (target === undefined) {
    throw new ActionCommentContractError(
      "sticky-comment selection unexpectedly returned no target",
    );
  }
  if (matches.length > 1) {
    delivery.warn(
      `found ${String(matches.length)} bot-owned capdelta comments; updating newest comment ${String(target.id)}`,
    );
  }
  try {
    await client.updateComment({
      owner: delivery.owner,
      repo: delivery.repo,
      commentId: target.id,
      body: delivery.body,
    });
  } catch (error: unknown) {
    throw new ActionCommentApiError("failed to update the PR comment", {
      cause: error,
    });
  }
  return { status: "updated", commentId: target.id };
}

function buildComment(
  report: JsonRunReport,
  artifactName: string,
  maxRows: number,
): string {
  const severity = assessRunSeverity(report);
  const lines = [
    COMMENT_MARKER,
    "## capdelta dependency review",
    "",
    report.firstRun
      ? "**First run:** no base lockfile was found. Review this aggregate capability inventory."
      : "Review this change: capdelta reports newly gained manifest capabilities.",
    "",
    "| Packages | Analyzed | Unavailable | Lockfile skips |",
    "| ---: | ---: | ---: | ---: |",
    `| ${String(report.summary.changedPackages)} | ${String(report.summary.analyzedPackages)} | ${String(report.summary.unavailablePackages)} | ${String(report.summary.skippedLockfileEntries)} |`,
    "",
    "| Critical | High | Medium | Low | Info |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${String(severity.counts.CRITICAL)} | ${String(severity.counts.HIGH)} | ${String(severity.counts.MEDIUM)} | ${String(severity.counts.LOW)} | ${String(severity.counts.INFO)} |`,
  ];

  const findings = collectFindings(report).slice(0, maxRows);
  if (findings.length > 0) {
    lines.push(
      "",
      "### Findings to review",
      "",
      "| Package | Severity | Change | Evidence |",
      "| --- | --- | --- | --- |",
      ...findings.map(
        ({ packageName, finding }) =>
          `| ${escapeMarkdownText(packageName, MAX_IDENTITY_CHARS)} | ${finding.severity} | ${escapeMarkdownText(findingText(finding), MAX_DETAIL_CHARS)} | ${escapeMarkdownText(evidenceText(finding), MAX_DETAIL_CHARS)} |`,
      ),
    );
  }

  const issues = collectIssues(report).slice(0, maxRows);
  if (issues.length > 0) {
    lines.push(
      "",
      "### Analysis gaps",
      "",
      "| Package | Stage | Detail | Source |",
      "| --- | --- | --- | --- |",
      ...issues.map(
        ({ packageName, issue }) =>
          `| ${escapeMarkdownText(packageName, MAX_IDENTITY_CHARS)} | ${escapeMarkdownText(issue.stage, MAX_IDENTITY_CHARS)} | ${escapeMarkdownText(issue.detail, MAX_DETAIL_CHARS)} | ${escapeMarkdownText(issue.url ?? "not available", MAX_DETAIL_CHARS)} |`,
      ),
    );
  }

  const shownFindings = findings.length;
  const totalFindings = report.summary.manifestFindings;
  const shownIssues = issues.length;
  const totalIssues = report.summary.analysisIssues;
  lines.push(
    "",
    `Showing ${String(shownFindings)} of ${String(totalFindings)} manifest findings and ${String(shownIssues)} of ${String(totalIssues)} analysis gaps.`,
    `Full escaped details are available in the workflow artifact ${escapeMarkdownText(artifactName, MAX_IDENTITY_CHARS)}.`,
  );
  return `${lines.join("\n")}\n`;
}

function collectFindings(
  report: JsonRunReport,
): { packageName: string; finding: JsonReportFinding }[] {
  return report.packages.flatMap((item) =>
    item.status === "analyzed"
      ? item.report.findings.map((finding) => ({
          packageName: item.report.package.name,
          finding,
        }))
      : [],
  );
}

function collectIssues(
  report: JsonRunReport,
): { packageName: string; issue: JsonReportAnalysisIssue }[] {
  return report.packages.flatMap((item) => {
    if (item.status === "analyzed") {
      return item.issues.map((issue) => ({
        packageName: item.report.package.name,
        issue,
      }));
    }
    return item.failures.map((issue) => ({
      packageName: item.package.name,
      issue,
    }));
  });
}

function findingText(finding: JsonReportFinding): string {
  const capability = finding.capability;
  switch (capability.kind) {
    case "INSTALL_HOOK":
      return `${finding.change.toLowerCase()} ${capability.hook} install hook`;
    case "COMMAND_ENTRYPOINT":
      return `${finding.change.toLowerCase()} command ${capability.command}`;
    case "DEPENDENCY":
      return `${finding.change.toLowerCase()} dependency ${capability.name}`;
    case "RUNTIME_CONSTRAINT":
      return `${finding.change.toLowerCase()} ${capability.runtime} constraint`;
    default:
      return `${finding.change.toLowerCase()} ${capability.kind} capability`;
  }
}

function evidenceText(finding: JsonReportFinding): string {
  const evidence = finding.capability.evidence[0];
  return evidence === undefined
    ? "evidence unavailable"
    : `${evidence.file}:${String(evidence.line)} ${evidence.snippet}`;
}

/**
 * Numeric entities are resolved as text after Markdown structure is parsed,
 * so hostile punctuation cannot open tables, links, HTML, or code spans.
 */
export function escapeMarkdownText(
  value: string,
  maxCharacters: number,
): string {
  const truncated = truncate(value, maxCharacters);
  let result = "";
  for (const character of truncated) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (isControl(codePoint)) {
      const visible = `\\u${codePoint.toString(16).padStart(4, "0")}`;
      for (const visibleCharacter of visible) {
        result += entityForPunctuation(visibleCharacter);
      }
      continue;
    }
    result += entityForPunctuation(character);
  }
  return result;
}

function entityForPunctuation(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return "";
  if (
    (codePoint >= 0x21 && codePoint <= 0x2f) ||
    (codePoint >= 0x3a && codePoint <= 0x40) ||
    (codePoint >= 0x5b && codePoint <= 0x60) ||
    (codePoint >= 0x7b && codePoint <= 0x7e)
  ) {
    return `&#${String(codePoint)};`;
  }
  return character;
}

function isControl(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x2060 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function truncate(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  if (maxCharacters === 0) return "";
  return `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

function validateDelivery(delivery: CommentDelivery): void {
  if (
    delivery.owner.length === 0 ||
    delivery.repo.length === 0 ||
    !Number.isSafeInteger(delivery.issueNumber) ||
    delivery.issueNumber <= 0 ||
    !delivery.body.includes(COMMENT_MARKER)
  ) {
    throw new ActionCommentConfigurationError(
      "comment delivery requires repository identity, PR number, and marker-bearing body",
    );
  }
}
