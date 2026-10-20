import type {
  JsonReportAnalysisIssue,
  JsonReportFinding,
  JsonReportLockfileFinding,
  JsonReportSignalFinding,
  JsonRunReport,
} from "../core/reporter.js";
import { NamedError } from "../core/named-error.js";
import { compareText } from "../core/compare.js";
import type { FindingSeverity } from "../core/capability-differ.js";
import {
  analysisIssueClass,
  analysisIssueGuidance,
  capabilityGuidance,
  guidanceWarranted,
  lockfileGuidance,
  signalGuidance,
  type AnalysisIssueClass,
  type Guidance,
} from "../core/finding-guidance.js";
import {
  assessRunSeverity,
  isUnanalyzableIssue,
} from "../core/run-severity.js";
import { truncate } from "../core/report-builder.js";
import { isPermissionRefusal } from "./permission-refusal.js";

export const COMMENT_MARKER = "<!-- capdelta:capability-report:v2 -->";
const LEGACY_COMMENT_MARKERS = ["<!-- capdelta:manifest-report:v1 -->"];
const DEFAULT_MAX_COMMENT_CHARS = 60_000;
const DEFAULT_MAX_ROWS = 10;
const MAX_IDENTITY_CHARS = 120;
const MAX_DETAIL_CHARS = 200;
export const MAX_GUIDANCE_CHARS = 512;
const FINDING_SEVERITY_ORDER = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
} as const;

const ANALYSIS_ISSUE_LABELS: Readonly<Record<AnalysisIssueClass, string>> = {
  "integrity-mismatch": "integrity mismatch",
  "lockfile-or-registry-fetch-failure": "lockfile or registry fetch failure",
  unanalyzable: "unanalyzable package",
  operational: "operational failure",
};

interface GuidanceRow {
  label: string;
  severity: FindingSeverity;
  guidance: Guidance;
}

/**
 * One row of the "Findings to review" table. Package capability/signal
 * findings and lockfile findings share the table, the severity ordering, and
 * the row cap. PLAN §3: lockfile strings are attacker-controlled and are
 * escaped rather than linked.
 */
type FindingRow =
  | {
      source: "package";
      packageName: string;
      finding: JsonReportFinding | JsonReportSignalFinding;
    }
  | { source: "lockfile"; finding: JsonReportLockfileFinding };

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
  readOnlyReason: "fork" | "token-denied" | null;
  addJobSummary(body: string): Promise<void>;
  warn(message: string): void;
}

export type CommentPublishResult =
  | { status: "created"; commentId: number }
  | { status: "updated"; commentId: number }
  | { status: "summary-only"; reason: "fork" | "token-denied" };

export class ActionCommentError extends NamedError {}

export class ActionCommentConfigurationError extends ActionCommentError {}

export class ActionCommentContractError extends ActionCommentError {}

export class ActionCommentApiError extends ActionCommentError {}

// PLAN §4.5
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

  const guidance = collectGuidance(report);
  // PLAN §4.5
  const base = fitBaseComment(report, artifactName, maxRows, maxCharacters);
  let body = base.body;
  let shown = 0;
  for (let candidate = 1; candidate <= guidance.length; candidate += 1) {
    const next = buildComment(
      report,
      artifactName,
      base.rows,
      guidance.slice(0, candidate),
      null,
    );
    if (Array.from(next).length > maxCharacters) break;
    shown = candidate;
    body = next;
  }
  const omitted = guidance.length - shown;
  if (omitted > 0) {
    const withNotice = buildComment(
      report,
      artifactName,
      base.rows,
      guidance.slice(0, shown),
      omitted,
    );
    if (Array.from(withNotice).length <= maxCharacters) body = withNotice;
  }
  return body;
}

function fitBaseComment(
  report: JsonRunReport,
  artifactName: string,
  maxRows: number,
  maxCharacters: number,
): { rows: number; body: string } {
  for (let rows = maxRows; rows >= 0; rows -= 1) {
    const body = buildComment(report, artifactName, rows, [], null);
    if (Array.from(body).length <= maxCharacters) return { rows, body };
  }
  throw new ActionCommentContractError(
    "fixed action-comment summary exceeds the configured size cap",
  );
}

export async function publishStickyComment(
  delivery: CommentDelivery,
  client: GitHubCommentClient,
): Promise<CommentPublishResult> {
  validateDelivery(delivery);
  if (delivery.readOnlyReason !== null) {
    return writeSummaryFallback(delivery, "fork");
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
          hasCommentMarker(comment.body),
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
      // ADR-020: a 403 "Resource not accessible by integration" means the token
      // lacks pull-requests: write. Degrade to the job summary; every other
      // failure stays loud.
      if (isPermissionRefusal(error)) {
        return writeSummaryFallback(delivery, "token-denied");
      }
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
    if (isPermissionRefusal(error)) {
      return writeSummaryFallback(delivery, "token-denied");
    }
    throw new ActionCommentApiError("failed to update the PR comment", {
      cause: error,
    });
  }
  return { status: "updated", commentId: target.id };
}

async function writeSummaryFallback(
  delivery: CommentDelivery,
  reason: "fork" | "token-denied",
): Promise<CommentPublishResult> {
  if (reason === "token-denied") {
    delivery.warn(
      "capdelta: the token cannot write the PR comment; add pull-requests: write to the workflow permissions; the comment is written to the job summary instead",
    );
  }
  try {
    await delivery.addJobSummary(delivery.body);
  } catch (error: unknown) {
    throw new ActionCommentApiError(
      "failed to write the read-only PR job summary",
      { cause: error },
    );
  }
  return { status: "summary-only", reason };
}

function buildComment(
  report: JsonRunReport,
  artifactName: string,
  maxRows: number,
  guidance: readonly GuidanceRow[],
  omittedGuidance: number | null,
): string {
  const severity = assessRunSeverity(report);
  const lines = [
    COMMENT_MARKER,
    "## capdelta dependency review",
    "",
    report.firstRun
      ? "**First run:** no base lockfile was found. Review this aggregate capability inventory."
      : "Review this change: capdelta reports newly gained capabilities.",
    "",
    "| Packages | Analyzed | Unavailable | Lockfile skips |",
    "| ---: | ---: | ---: | ---: |",
    `| ${String(report.summary.changedPackages)} | ${String(report.summary.analyzedPackages)} | ${String(report.summary.unavailablePackages)} | ${String(report.summary.skippedLockfileEntries)} |`,
    "",
    "| Critical | High | Medium | Low | Info |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${String(severity.counts.CRITICAL)} | ${String(severity.counts.HIGH)} | ${String(severity.counts.MEDIUM)} | ${String(severity.counts.LOW)} | ${String(severity.counts.INFO)} |`,
  ];
  if (report.budget?.partial === true) {
    lines.push(
      "",
      `**Partial analysis:** ${String(report.budget.completedPackages)} of ${String(report.summary.changedPackages)} packages reached a result; ${String(report.budget.unstartedPackages)} were not started before ${report.budget.deadlineExceeded ? `${String(report.budget.deadlineMs)}ms wall-clock budget` : "caller cancellation"}.`,
    );
  }

  const findings = collectFindings(report).slice(0, maxRows);
  if (findings.length > 0) {
    lines.push(
      "",
      "### Findings to review",
      "",
      "| Package | Severity | Change | Evidence |",
      "| --- | --- | --- | --- |",
      ...findings.map(
        (row) =>
          `| ${escapeMarkdownText(rowPackageName(row), MAX_IDENTITY_CHARS)} | ${rowSeverity(row)} | ${escapeMarkdownText(rowChange(row), MAX_DETAIL_CHARS)} | ${escapeMarkdownText(rowEvidence(row), MAX_DETAIL_CHARS)} |`,
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
      ...issues.map(({ packageName, issue }) => {
        // ADR-016
        const stage = isUnanalyzableIssue(issue)
          ? `could not analyze: ${issue.stage}`
          : issue.stage;
        return `| ${escapeMarkdownText(packageName, MAX_IDENTITY_CHARS)} | ${escapeMarkdownText(stage, MAX_IDENTITY_CHARS)} | ${escapeMarkdownText(issue.detail, MAX_DETAIL_CHARS)} | ${escapeMarkdownText(issue.url ?? "not available", MAX_DETAIL_CHARS)} |`;
      }),
    );
  }

  const allExceptions = collectExceptions(report);
  const exceptions = allExceptions.slice(0, maxRows);
  const baselineFailures = collectBaselineFailures(report).slice(0, maxRows);
  if (baselineFailures.length > 0) {
    lines.push(
      "",
      "### Baseline failures",
      "",
      ...baselineFailures.map(
        ({ packageName, issue }) =>
          `- ${escapeMarkdownText(packageName, MAX_IDENTITY_CHARS)}: Old version could not be analyzed (${truncate(issue.kind, MAX_IDENTITY_CHARS)}); every capability of the new version is reported as added.`,
      ),
    );
  }
  if (allExceptions.length > 0) {
    // ADR-017
    lines.push(
      "",
      "### Reviewed exceptions",
      "",
      ...exceptions.map(
        ({ packageName, reason }) =>
          `- ${escapeMarkdownText(packageName, MAX_IDENTITY_CHARS)}: reviewed exception: ${escapeMarkdownText(reason, MAX_DETAIL_CHARS)}`,
      ),
    );
    const hiddenExceptions = allExceptions.length - exceptions.length;
    if (hiddenExceptions > 0) {
      // ADR-017: a suppressed finding must not disappear from the reviewer's view.
      lines.push(
        `- ${String(hiddenExceptions)} more reviewed ${hiddenExceptions === 1 ? "exception is" : "exceptions are"} in the workflow artifact.`,
      );
    }
  }

  if (guidance.length > 0) {
    // PLAN §4.5
    lines.push(
      "",
      "### What these mean",
      "",
      ...guidance.map(
        (row) =>
          `- **${escapeMarkdownText(row.label, MAX_IDENTITY_CHARS)}**: ${escapeMarkdownText(`${row.guidance.whyItMatters} ${row.guidance.whatToCheck}`, MAX_GUIDANCE_CHARS)}`,
      ),
    );
  }

  const shownFindings = findings.length;
  const totalFindings =
    report.summary.capabilityFindings +
    (report.summary.signalFindings ?? 0) +
    report.summary.lockfileFindings;
  const shownIssues = issues.length + baselineFailures.length;
  const totalIssues = report.summary.analysisIssues;
  lines.push(
    "",
    `Showing ${String(shownFindings)} of ${String(totalFindings)} findings and ${String(shownIssues)} of ${String(totalIssues)} analysis gaps.`,
  );
  const omittedGuidanceCount = omittedGuidance ?? 0;
  if (omittedGuidanceCount > 0) {
    // PLAN §4.5
    lines.push(
      `Guidance for ${String(omittedGuidanceCount)} ${omittedGuidanceCount === 1 ? "class" : "classes"} was omitted; see the SARIF rule help.`,
    );
  }
  lines.push(
    `Full escaped details are available in the workflow artifact ${escapeMarkdownText(artifactName, MAX_IDENTITY_CHARS)}.`,
  );
  return `${lines.join("\n")}\n`;
}

function collectFindings(report: JsonRunReport): FindingRow[] {
  const packageFindings: FindingRow[] = report.packages.flatMap((item) =>
    item.status === "analyzed"
      ? [
          ...item.report.findings.map((finding): FindingRow => ({
            source: "package",
            packageName: item.report.package.name,
            finding,
          })),
          ...(item.report.signalFindings ?? []).map((finding): FindingRow => ({
            source: "package",
            packageName: item.report.package.name,
            finding,
          })),
        ]
      : [],
  );
  const lockfileFindings: FindingRow[] = report.lockfileFindings.map(
    (finding) => ({ source: "lockfile", finding }),
  );
  return [...packageFindings, ...lockfileFindings].sort(compareFindingRows);
}

function rowPackageName(row: FindingRow): string {
  return row.source === "lockfile" ? row.finding.name : row.packageName;
}

function rowSeverity(row: FindingRow): FindingSeverity {
  return row.finding.severity;
}

function rowChange(row: FindingRow): string {
  return row.source === "lockfile"
    ? row.finding.kind
    : findingText(row.finding);
}

function rowEvidence(row: FindingRow): string {
  return row.source === "lockfile"
    ? `${row.finding.path}: ${row.finding.oldVersion ?? "none"} -> ${row.finding.newVersion}`
    : evidenceText(row.finding);
}

function compareFindingRows(left: FindingRow, right: FindingRow): number {
  const severity =
    FINDING_SEVERITY_ORDER[rowSeverity(left)] -
    FINDING_SEVERITY_ORDER[rowSeverity(right)];
  if (severity !== 0) return severity;
  return (
    compareText(rowPackageName(left), rowPackageName(right)) ||
    compareText(rowChange(left), rowChange(right)) ||
    compareText(rowEvidence(left), rowEvidence(right))
  );
}

function hasCommentMarker(body: string | null): boolean {
  return (
    body?.includes(COMMENT_MARKER) === true ||
    LEGACY_COMMENT_MARKERS.some((marker) => body?.includes(marker) === true)
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

function collectBaselineFailures(
  report: JsonRunReport,
): { packageName: string; issue: JsonReportAnalysisIssue }[] {
  return report.packages.flatMap((item) =>
    item.status === "analyzed"
      ? item.baselineFailures.map((issue) => ({
          packageName: item.report.package.name,
          issue,
        }))
      : [],
  );
}

function collectExceptions(
  report: JsonRunReport,
): { packageName: string; reason: string }[] {
  return report.packages.flatMap((item) =>
    item.status === "unavailable" && item.exception !== undefined
      ? [{ packageName: item.package.name, reason: item.exception.reason }]
      : [],
  );
}

function collectGuidance(report: JsonRunReport): GuidanceRow[] {
  const rows = new Map<string, GuidanceRow>();
  const add = (
    key: string,
    label: string,
    severity: FindingSeverity,
    guidance: Guidance,
  ): void => {
    const existing = rows.get(key);
    if (
      existing === undefined ||
      FINDING_SEVERITY_ORDER[severity] <
        FINDING_SEVERITY_ORDER[existing.severity]
    ) {
      rows.set(key, { label, severity, guidance });
    }
  };

  for (const row of collectFindings(report)) {
    if (!guidanceWarranted(rowSeverity(row))) continue;
    if (row.source === "lockfile") {
      add(
        `lockfile:${row.finding.kind}`,
        row.finding.kind,
        row.finding.severity,
        lockfileGuidance(row.finding.kind),
      );
    } else if ("kind" in row.finding && "detail" in row.finding) {
      add(
        `signal:${row.finding.kind}`,
        row.finding.kind,
        row.finding.severity,
        signalGuidance(row.finding.kind),
      );
    } else {
      const kind = row.finding.capability.kind;
      add(
        `capability:${kind}`,
        kind,
        row.finding.severity,
        capabilityGuidance(kind),
      );
    }
  }

  for (const { issue } of collectIssues(report)) {
    if (issue.severity === null || !guidanceWarranted(issue.severity)) continue;
    const issueClass = analysisIssueClass(issue);
    const guidance = analysisIssueGuidance(issue);
    if (issueClass === null || guidance === null) {
      throw new ActionCommentContractError(
        `no guidance class for severity-bearing analysis issue ${issue.stage}/${issue.kind}`,
      );
    }
    add(
      `analysis:${issueClass}`,
      ANALYSIS_ISSUE_LABELS[issueClass],
      issue.severity,
      guidance,
    );
  }

  return [...rows.values()].sort(
    (left, right) =>
      FINDING_SEVERITY_ORDER[left.severity] -
        FINDING_SEVERITY_ORDER[right.severity] ||
      compareText(left.label, right.label),
  );
}

function findingText(
  finding: JsonReportFinding | JsonReportSignalFinding,
): string {
  let description: string;
  if ("kind" in finding && "detail" in finding) {
    description = `${finding.change.toLowerCase()} signal: ${finding.detail}`;
  } else {
    const capability = finding.capability;
    switch (capability.kind) {
      case "INSTALL_HOOK":
        description = `${finding.change.toLowerCase()} "${capability.hook}" install hook`;
        break;
      case "COMMAND_ENTRYPOINT":
        description = `${finding.change.toLowerCase()} command ${capability.command}`;
        break;
      case "DEPENDENCY":
        description = `${finding.change.toLowerCase()} dependency ${capability.name}`;
        break;
      case "RUNTIME_CONSTRAINT":
        description = `${finding.change.toLowerCase()} ${capability.runtime} constraint`;
        break;
      default:
        description = `${finding.change.toLowerCase()} ${capability.kind} capability`;
    }
  }
  return `${description}${suppressionText(finding.suppression?.reason)}`;
}

function suppressionText(reason: string | undefined): string {
  return reason === undefined ? "" : ` (suppressed (${reason}))`;
}

function evidenceText(
  finding: JsonReportFinding | JsonReportSignalFinding,
): string {
  const evidence =
    "kind" in finding && "detail" in finding
      ? finding.evidence[0]
      : finding.capability.evidence[0];
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
