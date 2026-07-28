import {
  analyzeChangedPackages,
  type CapabilityAnalysisRun,
} from "../core/capability-analysis-pipeline.js";
import { diffNpmLockfiles } from "../core/npm/lockfile-differ.js";
import {
  REPORT_SCHEMA_VERSION,
  renderJsonRunReport,
  type JsonRunReport,
} from "../core/reporter.js";
import { renderSarifReport } from "../core/sarif-reporter.js";
import {
  publishStickyComment,
  renderActionComment,
  type CommentPublishResult,
  type GitHubCommentClient,
} from "./action-comment-reporter.js";
import {
  retrieveBaseLockfile,
  validateLockfilePath,
  type GitHubContentsClient,
} from "./base-lockfile-retriever.js";
import {
  evaluateSeverityGate,
  parseFailOn,
  type GateDecision,
} from "./severity-gate.js";

export interface ActionInputs {
  lockfilePath: string;
  failOn: string;
  configPath: string;
  baseRef: string;
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
    };

export class ActionRunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ActionRunnerConfigurationError extends ActionRunnerError {}

export class ActionRunnerOperationalError extends ActionRunnerError {}

const ARTIFACT_NAME = "capdelta-report";

/** Run the M2 Action pipeline without converting failures into process state. */
export async function runAction(
  inputs: ActionInputs,
  context: ActionContext,
  adapters: ActionAdapters,
): Promise<ActionOutcome> {
  validateInputs(inputs, context);
  const threshold = parseFailOn(inputs.failOn);
  if (inputs.configPath.length > 0) {
    throw new ActionRunnerConfigurationError(
      "config-path is reserved for allowlists and is not supported until M4",
    );
  }

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

  const oldLockfile =
    base.status === "missing" ? null : parseLockfile(base.text, "base");
  const headLockfile = parseLockfile(headText, "head");
  const analysis = await withContext("analyze changed packages", () =>
    adapters.analyze(oldLockfile, headLockfile),
  );
  const json = renderJsonRunReport(analysis);
  const sarif = renderSarifReport(analysis);
  const report = parseRenderedReport(json);

  const artifact = await withContext("upload JSON report artifact", () =>
    adapters.uploadJson(ARTIFACT_NAME, json),
  );
  const readOnlyReason =
    context.actor === "dependabot[bot]"
      ? "dependabot"
      : context.headRepository !== context.baseRepository
        ? "fork"
        : null;
  let sarifUploaded = false;
  if (readOnlyReason === null) {
    await withContext("upload SARIF report", () =>
      adapters.uploadSarif(sarif, {
        commitSha: context.headSha,
        ref: `refs/pull/${String(context.pullRequestNumber)}/head`,
      }),
    );
    sarifUploaded = true;
  } else {
    adapters.warn(
      `capdelta: ${readOnlyReason} PR cannot upload SARIF with the read-only token; JSON artifact and job summary remain available`,
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

  adapters.setOutput("status", gate.fail ? "failed" : "passed");
  adapters.setOutput("artifact-id", String(artifact.id));
  adapters.setOutput("highest-severity", gate.highest ?? "none");
  return {
    status: "analyzed",
    firstRun: report.firstRun,
    artifact,
    comment,
    gate,
    sarifUploaded,
  };
}

function validateInputs(inputs: ActionInputs, context: ActionContext): void {
  validateLockfilePath(inputs.lockfilePath);
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

/** Default analyzer used by the production adapter. */
export async function analyzeLockfiles(
  oldLockfile: unknown,
  newLockfile: unknown,
): Promise<CapabilityAnalysisRun> {
  return analyzeChangedPackages(diffNpmLockfiles(oldLockfile, newLockfile));
}
