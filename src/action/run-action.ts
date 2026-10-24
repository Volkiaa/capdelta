import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
  type CapabilityAnalysisRun,
} from "../core/capability-analysis-pipeline.js";
import { NamedError } from "../core/named-error.js";
import { diffNpmLockfiles } from "../core/npm/lockfile-differ.js";
import {
  IntelClientConfigurationError,
  lookupIntel,
  validateIntelUrl,
} from "../core/intel-client.js";
import { intelMatches } from "../core/intel-match.js";
import { isNormalizedRelativePosixPath } from "../core/repository-path.js";
import {
  emptyCapdeltaConfig,
  parseCapdeltaConfig,
  type CapdeltaConfig,
} from "../core/capdelta-config.js";
import {
  REPORT_SCHEMA_VERSION,
  renderJsonRunReport,
  type JsonRunReport,
} from "../core/reporter.js";
import type { LockfileFinding } from "../core/contract/lockfile-diff.js";
import { renderSarifReport } from "../core/sarif-reporter.js";
import {
  publishStickyComment,
  renderActionComment,
  type CommentPublishResult,
  type GitHubCommentClient,
} from "./action-comment-reporter.js";
import {
  retrieveBaseFile,
  retrieveBaseLockfile,
  validateLockfilePath,
  type GitHubContentsClient,
} from "./base-lockfile-retriever.js";
import { isPermissionRefusal } from "./permission-refusal.js";
import {
  evaluateSeverityGate,
  hasOperationalFailure,
  operationalFailureCount,
  operationalFailureMessage,
  parseFailOn,
  type GateDecision,
} from "../core/run-severity.js";

export interface ActionInputs {
  lockfilePath: string;
  failOn: string;
  configPath: string;
  baseRef: string;
  strict?: boolean;
  intelUrl?: string;
}

export interface ActionContext {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  headRef: string;
  baseRepository: string;
  headRepository: string;
  actor: string;
}

export interface ArtifactUpload {
  id: number;
  name: string;
}

export interface ActionAdapters {
  listChangedFiles(): Promise<readonly string[]>;
  resolveCommit(ref: string): Promise<string>;
  contents: GitHubContentsClient;
  readHeadLockfile(path: string): Promise<string>;
  analyze(
    oldLockfile: unknown,
    newLockfile: unknown,
    config?: CapdeltaConfig,
  ): Promise<CapabilityAnalysisRun>;
  uploadJson(name: string, contents: string): Promise<ArtifactUpload>;
  uploadSarif(
    contents: string,
    target: { commitSha: string; ref: string },
  ): Promise<void>;
  comments: GitHubCommentClient;
  addJobSummary(markdown: string): Promise<void>;
  warn(message: string): void;
  setOutput(name: string, value: string): void;
  /** Test seam: the intelligence lookup shares the Action's fetch boundary. */
  fetchImpl?: typeof fetch;
}

export type ActionOutcome =
  | { status: "no-op" }
  | {
      status: "analyzed";
      firstRun: boolean;
      artifact: ArtifactUpload;
      comment: CommentPublishResult;
      gate: GateDecision;
      sarifUploaded: boolean;
      strictFailure: boolean;
      /** ADR-018: a transient fetch or stop left the analysis incomplete. */
      operationalFailure: boolean;
      operationalFailureCount: number;
    };

export class ActionRunnerError extends NamedError {}

export class ActionRunnerConfigurationError extends ActionRunnerError {}

export class ActionRunnerOperationalError extends ActionRunnerError {}

/**
 * ADR-018: the message the Action fails with, or `null` when the run passes.
 * The gate message and the operational message are joined so neither cause is
 * hidden; a strict failure is the fallback, matching the CLI's precedence.
 */
export function actionFailureMessage(outcome: {
  gate: Pick<GateDecision, "fail" | "matchingCount" | "threshold">;
  operationalFailure: boolean;
  operationalFailureCount: number;
  strictFailure: boolean;
}): string | null {
  const failures: string[] = [];
  if (outcome.gate.fail) {
    failures.push(
      `Review this change: ${String(outcome.gate.matchingCount)} finding(s) meet the ${outcome.gate.threshold} failure threshold.`,
    );
  }
  if (outcome.operationalFailure) {
    failures.push(operationalFailureMessage(outcome.operationalFailureCount));
  }
  if (failures.length > 0) return failures.join(" ");
  if (outcome.strictFailure) return "Strict mode found unanalyzed content.";
  return null;
}

const ARTIFACT_NAME = "capdelta-report";

export async function runAction(
  inputs: ActionInputs,
  context: ActionContext,
  adapters: ActionAdapters,
): Promise<ActionOutcome> {
  validateInputs(inputs, context);
  const threshold = parseFailOn(inputs.failOn);

  const changedFiles = await withContext("list PR files", () =>
    adapters.listChangedFiles(),
  );
  if (!changedFiles.includes(inputs.lockfilePath)) {
    adapters.setOutput("status", "no-op");
    return { status: "no-op" };
  }

  const baseSha =
    inputs.baseRef.length === 0
      ? context.baseSha
      : await withContext("resolve base-ref", () =>
          adapters.resolveCommit(inputs.baseRef),
        );
  const [base, headText] = await Promise.all([
    retrieveBaseLockfile(
      {
        owner: context.owner,
        repo: context.repo,
        path: inputs.lockfilePath,
        ref: baseSha,
      },
      adapters.contents,
    ),
    withContext("read head lockfile", () =>
      adapters.readHeadLockfile(inputs.lockfilePath),
    ),
  ]);

  const config = await readBasePolicy(
    inputs.configPath,
    baseSha,
    changedFiles,
    context,
    adapters,
  );

  const oldLockfile =
    base.status === "missing" ? null : parseLockfile(base.text, "base");
  const headLockfile = parseLockfile(headText, "head");
  const intel = await lookupConfiguredIntel(
    inputs.intelUrl,
    oldLockfile,
    headLockfile,
    adapters,
  );
  const analyzed = await withContext("analyze changed packages", () =>
    inputs.configPath.length === 0
      ? adapters.analyze(oldLockfile, headLockfile)
      : adapters.analyze(oldLockfile, headLockfile, config),
  );
  const analysis: CapabilityAnalysisRun =
    intel.findings.length === 0
      ? analyzed
      : {
          ...analyzed,
          lockfileFindings: [...analyzed.lockfileFindings, ...intel.findings],
        };
  const json = renderJsonRunReport(analysis);
  const sarif = renderSarifReport(analysis, {
    lockfilePath: inputs.lockfilePath,
  });
  const report = parseRenderedReport(json);

  const artifact = await withContext("upload JSON report artifact", () =>
    adapters.uploadJson(ARTIFACT_NAME, json),
  );
  // ADR-020: only a fork gets a guaranteed read-only token. Every other PR,
  // Dependabot included, attempts the writes and degrades on a 403 refusal.
  const readOnlyReason =
    context.headRepository !== context.baseRepository ? "fork" : null;
  let sarifUploaded = false;
  if (readOnlyReason === null) {
    try {
      await adapters.uploadSarif(sarif, {
        commitSha: context.headSha,
        ref: `refs/pull/${String(context.pullRequestNumber)}/head`,
      });
      sarifUploaded = true;
    } catch (error: unknown) {
      // Classify the raw error before `withContext` wraps it, so a refused
      // upload warns instead of failing the run.
      if (!isPermissionRefusal(error)) {
        if (error instanceof ActionRunnerError) throw error;
        throw new ActionRunnerOperationalError(
          "failed to upload SARIF report",
          {
            cause: error,
          },
        );
      }
      adapters.warn(
        "capdelta: the token cannot upload SARIF; add security-events: write to the workflow permissions; the JSON artifact and job summary remain available",
      );
    }
  } else {
    adapters.warn(
      "capdelta: fork PR cannot upload SARIF with the read-only token; JSON artifact and job summary remain available",
    );
  }
  const body = renderActionComment(report, {
    artifactName: `${ARTIFACT_NAME}.json`,
  });
  const comment = await publishStickyComment(
    {
      owner: context.owner,
      repo: context.repo,
      issueNumber: context.pullRequestNumber,
      body,
      readOnlyReason,
      addJobSummary: (markdown) => adapters.addJobSummary(markdown),
      warn: (message) => {
        adapters.warn(message);
      },
    },
    adapters.comments,
  );
  const gate = evaluateSeverityGate(report, threshold);
  const strictFailure =
    inputs.strict === true && hasUnanalyzedContent(analysis);
  // ADR-018: an operational failure fails the job even in report-only mode,
  // independent of the severity gate.
  const operationalFailure = hasOperationalFailure(analysis);
  const operationalFailures = operationalFailureCount(analysis);

  adapters.setOutput(
    "status",
    gate.fail || operationalFailure ? "failed" : "passed",
  );
  adapters.setOutput("artifact-id", String(artifact.id));
  adapters.setOutput("highest-severity", gate.highest ?? "none");
  adapters.setOutput("strict-failed", strictFailure ? "true" : "false");
  return {
    status: "analyzed",
    firstRun: report.firstRun,
    artifact,
    comment,
    gate,
    sarifUploaded,
    strictFailure,
    operationalFailure,
    operationalFailureCount: operationalFailures,
  };
}

const MAX_CONFIG_BYTES = 256 * 1024;

async function lookupConfiguredIntel(
  intelUrl: string | undefined,
  oldLockfile: unknown,
  headLockfile: unknown,
  adapters: ActionAdapters,
): Promise<{ findings: LockfileFinding[] }> {
  if (intelUrl === undefined || intelUrl.length === 0) return { findings: [] };
  // The feed URL is an Action input only. Reading it from .capdelta.yml would
  // let a pull request point the check at a feed that never matches (ADR-015).
  const diff = diffNpmLockfiles(oldLockfile, headLockfile);
  const lookup = await withContext("look up intelligence findings", () =>
    lookupIntel(diff.changed, {
      baseUrl: intelUrl,
      ...(adapters.fetchImpl === undefined
        ? {}
        : { fetchImpl: adapters.fetchImpl }),
    }),
  );
  for (const warning of lookup.warnings) {
    adapters.warn(`capdelta: ${warning}`);
  }
  return { findings: intelMatches(diff.changed, lookup.findings) };
}

/**
 * Policy comes from the same immutable base commit as the base lockfile,
 * never from the PR checkout: otherwise a PR could add an exception that
 * suppresses its own findings (ADR-015). Head changes are only reported.
 */
async function readBasePolicy(
  configPath: string,
  baseSha: string,
  changedFiles: readonly string[],
  context: ActionContext,
  adapters: ActionAdapters,
): Promise<CapdeltaConfig> {
  if (configPath.length === 0) return emptyCapdeltaConfig();
  const file = await withContext("read base config", () =>
    retrieveBaseFile(
      {
        owner: context.owner,
        repo: context.repo,
        path: configPath,
        ref: baseSha,
        maxBytes: MAX_CONFIG_BYTES,
        label: "config",
      },
      adapters.contents,
    ),
  );
  if (changedFiles.includes(configPath)) {
    adapters.warn(
      `capdelta: this PR changes ${configPath}; policy is read from the selected base commit, so those changes do not apply to this run`,
    );
  }
  if (file.status === "missing") {
    adapters.warn(
      `capdelta: ${configPath} is not present at base ${baseSha}; no exceptions applied`,
    );
    return emptyCapdeltaConfig();
  }
  try {
    return parseCapdeltaConfig(file.text);
  } catch (error: unknown) {
    throw new ActionRunnerConfigurationError("base config is invalid", {
      cause: error,
    });
  }
}

function validateInputs(inputs: ActionInputs, context: ActionContext): void {
  validateLockfilePath(inputs.lockfilePath);
  if (
    inputs.configPath.length > 0 &&
    !isNormalizedRelativePosixPath(inputs.configPath)
  ) {
    throw new ActionRunnerConfigurationError(
      "config-path must be a normalized relative POSIX path",
    );
  }
  if (inputs.intelUrl !== undefined && inputs.intelUrl.length > 0) {
    try {
      validateIntelUrl(inputs.intelUrl);
    } catch (error: unknown) {
      if (error instanceof IntelClientConfigurationError) {
        throw new ActionRunnerConfigurationError(error.message, {
          cause: error,
        });
      }
      throw error;
    }
  }
  if (
    context.owner.length === 0 ||
    context.repo.length === 0 ||
    context.baseRepository.length === 0 ||
    context.headRepository.length === 0 ||
    !Number.isSafeInteger(context.pullRequestNumber) ||
    context.pullRequestNumber <= 0 ||
    !/^[0-9a-f]{40,64}$/iu.test(context.baseSha) ||
    !/^[0-9a-f]{40,64}$/iu.test(context.headSha) ||
    context.headRef.length === 0
  ) {
    throw new ActionRunnerConfigurationError(
      "Action requires a pull_request context with an immutable base SHA",
    );
  }
}

function parseLockfile(text: string, side: "base" | "head"): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new ActionRunnerOperationalError(
      `${side} lockfile is not valid JSON`,
      { cause: error },
    );
  }
}

function parseRenderedReport(json: string): JsonRunReport {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new ActionRunnerOperationalError(
      "internal JSON reporter emitted invalid JSON",
      { cause: error },
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== REPORT_SCHEMA_VERSION
  ) {
    throw new ActionRunnerOperationalError(
      "internal JSON reporter emitted an unsupported schema",
    );
  }
  return value as JsonRunReport;
}

async function withContext<T>(
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    if (error instanceof ActionRunnerError) throw error;
    throw new ActionRunnerOperationalError(`failed to ${operation}`, {
      cause: error,
    });
  }
}

export async function analyzeLockfiles(
  oldLockfile: unknown,
  newLockfile: unknown,
  config?: CapdeltaConfig,
): Promise<CapabilityAnalysisRun> {
  return analyzeChangedPackages(diffNpmLockfiles(oldLockfile, newLockfile), {
    ...(config === undefined ? {} : { config }),
  });
}
