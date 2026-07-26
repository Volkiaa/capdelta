import * as core from "@actions/core";
import artifact from "@actions/artifact";
import * as github from "@actions/github";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  analyzeLockfiles,
  runAction,
  type ActionContext,
} from "./action/run-action.js";
import type {
  GitHubComment,
  GitHubCommentClient,
} from "./action/action-comment-reporter.js";
import type {
  GitHubContentsClient,
  GitHubContentsRequest,
} from "./action/base-lockfile-retriever.js";

const MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_CHARACTERS = 500;
const MAX_ERROR_CHAIN = 3;

async function main(): Promise<void> {
  try {
    const token = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(token);
    const context = actionContext();

    const outcome = await runAction(
      {
        lockfilePath: core.getInput("lockfile-path") || "package-lock.json",
        failOn: core.getInput("fail-on") || "CRITICAL",
        configPath: core.getInput("config-path"),
        baseRef: core.getInput("base-ref"),
      },
      context,
      {
        listChangedFiles: async () =>
          octokit.paginate(
            octokit.rest.pulls.listFiles,
            {
              owner: context.owner,
              repo: context.repo,
              pull_number: context.pullRequestNumber,
              per_page: 100,
            },
            (response) => response.data.map((file) => file.filename),
          ),
        resolveCommit: async (ref) => {
          const response = await octokit.rest.repos.getCommit({
            owner: context.owner,
            repo: context.repo,
            ref,
          });
          return response.data.sha;
        },
        contents: contentsClient(octokit),
        readHeadLockfile,
        analyze: analyzeLockfiles,
        uploadJson,
        comments: commentClient(octokit),
        addJobSummary: async (markdown) => {
          await core.summary.addRaw(markdown).write();
        },
        warn: core.warning,
        setOutput: core.setOutput,
      },
    );

    if (outcome.status === "analyzed" && outcome.gate.fail) {
      core.setFailed(
        `Review this change: ${String(outcome.gate.matchingCount)} finding(s) meet the ${outcome.gate.threshold} failure threshold.`,
      );
    }
  } catch (error: unknown) {
    core.setFailed(`capdelta: ${safeError(error)}`);
  }
}

function actionContext(): ActionContext {
  if (github.context.eventName !== "pull_request") {
    throw new Error("capdelta Action currently requires a pull_request event");
  }
  const pullRequest = parsePullRequest(github.context.payload.pull_request);
  const [owner, repo] =
    github.context.repo.owner.length > 0
      ? [github.context.repo.owner, github.context.repo.repo]
      : ["", ""];
  return {
    owner,
    repo,
    pullRequestNumber: pullRequest.number,
    baseSha: pullRequest.baseSha,
    baseRepository: pullRequest.baseRepository,
    headRepository: pullRequest.headRepository,
    actor: github.context.actor,
  };
}

type Octokit = ReturnType<typeof github.getOctokit>;

function contentsClient(octokit: Octokit): GitHubContentsClient {
  return {
    async getContent(request: GitHubContentsRequest, mediaType) {
      const response = await octokit.rest.repos.getContent({
        owner: request.owner,
        repo: request.repo,
        path: request.path,
        ref: request.ref,
        mediaType: { format: mediaType },
      });
      return { status: response.status, data: response.data };
    },
  };
}

function commentClient(octokit: Octokit): GitHubCommentClient {
  return {
    async listComments(input): Promise<readonly GitHubComment[]> {
      const response = await octokit.rest.issues.listComments({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        page: input.page,
        per_page: input.perPage,
      });
      return response.data.map((comment) => ({
        id: comment.id,
        body: comment.body ?? null,
        authorLogin: comment.user?.login ?? null,
      }));
    },
    async createComment(input) {
      const response = await octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body: input.body,
      });
      return { id: response.data.id };
    },
    async updateComment(input) {
      await octokit.rest.issues.updateComment({
        owner: input.owner,
        repo: input.repo,
        comment_id: input.commentId,
        body: input.body,
      });
    },
  };
}

async function readHeadLockfile(path: string): Promise<string> {
  const root = process.cwd();
  const file = resolve(root, ...path.split("/"));
  const fromRoot = relative(root, file);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("head lockfile path escapes the checkout");
  }
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("head lockfile must be a regular file, not a symlink");
  }
  if (metadata.size > MAX_LOCKFILE_BYTES) {
    throw new Error(
      `head lockfile exceeds the ${String(MAX_LOCKFILE_BYTES)} byte limit`,
    );
  }
  const bytes = await readFile(file);
  if (bytes.byteLength > MAX_LOCKFILE_BYTES) {
    throw new Error(
      `head lockfile exceeds the ${String(MAX_LOCKFILE_BYTES)} byte limit`,
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function uploadJson(name: string, contents: string) {
  const directory = await mkdtemp(join(tmpdir(), "capdelta-report-"));
  const file = join(directory, `${name}.json`);
  let response: Awaited<ReturnType<typeof artifact.uploadArtifact>> | undefined;
  let operationError: unknown;
  try {
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
    response = await artifact.uploadArtifact(name, [file], directory);
  } catch (error: unknown) {
    operationError = error;
  }
  try {
    await rm(directory, { recursive: true, force: false });
  } catch (error: unknown) {
    core.warning(`capdelta report cleanup failed: ${safeError(error)}`);
  }
  if (operationError !== undefined) {
    throw new Error("artifact upload failed", { cause: operationError });
  }
  if (response?.id === undefined) {
    throw new Error("artifact service returned no artifact ID");
  }
  return { id: response.id, name };
}

interface PullRequestFields {
  number: number;
  baseSha: string;
  baseRepository: string;
  headRepository: string;
}

function parsePullRequest(value: unknown): PullRequestFields {
  if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.head)) {
    throw new Error("pull_request payload is missing repository metadata");
  }
  const baseRepo = value.base.repo;
  const headRepo = value.head.repo;
  if (
    typeof value.number !== "number" ||
    typeof value.base.sha !== "string" ||
    !isRecord(baseRepo) ||
    typeof baseRepo.full_name !== "string"
  ) {
    throw new Error(
      "pull_request payload contains invalid repository metadata",
    );
  }
  let headRepository = "unknown/fork";
  if (headRepo !== null) {
    if (!isRecord(headRepo) || typeof headRepo.full_name !== "string") {
      throw new Error(
        "pull_request payload contains invalid head repository metadata",
      );
    }
    headRepository = headRepo.full_name;
  }
  return {
    number: value.number,
    baseSha: value.base.sha,
    baseRepository: baseRepo.full_name,
    headRepository,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CHAIN; depth += 1) {
    if (seen.has(current)) {
      messages.push("caused by [cycle]");
      break;
    }
    seen.add(current);
    messages.push(
      `${depth === 0 ? "" : "caused by "}${current instanceof Error ? `${current.name}: ${current.message}` : typeof current}`,
    );
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  const truncated = Array.from(messages.join("; "))
    .slice(0, MAX_ERROR_CHARACTERS)
    .join("");
  return JSON.stringify(truncated).slice(1, -1);
}

await main();
