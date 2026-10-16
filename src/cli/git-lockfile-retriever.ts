import { spawn, type ChildProcessByStdio } from "node:child_process";
import { isNormalizedRelativePosixPath } from "../core/repository-path.js";
import { truncate } from "../core/report-builder.js";
import type { Readable } from "node:stream";
import { CliOperationalError, MAX_CLI_ERROR_CHARS } from "./cli-errors.js";

const LOCKFILE_NAME = "package-lock.json";
const GIT_METADATA_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_TERMINATION_GRACE_MS = 1_000;

interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface GitProcessRuntime {
  /** Test seam; production starts Git without a shell. */
  spawnImpl?: typeof spawn;
  commandTimeoutMs?: number;
  terminationGraceMs?: number;
}

export type GitLockfileInspection =
  { changed: false } | { changed: true; commit: string };

/**
 * Resolves the base to an immutable commit, takes the no-op fast path when the
 * lockfile is unchanged, and otherwise returns the immutable commit to read.
 */
export async function inspectGitLockfileChange(
  base: string,
  cwd: string,
  runtime: GitProcessRuntime = {},
): Promise<GitLockfileInspection> {
  const commit = await resolveBaseCommit(base, cwd, runtime);
  if (!(await lockfileChanged(commit, cwd, runtime))) {
    return { changed: false };
  }
  return { changed: true, commit };
}

async function resolveBaseCommit(
  base: string,
  cwd: string,
  runtime: GitProcessRuntime,
): Promise<string> {
  const result = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
    runtime,
  );
  if (result.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot resolve base revision ${JSON.stringify(base)}: ${gitDetail(result)}`,
    );
  }
  const commit = decodeUtf8(result.stdout, "Git commit output").trim();
  if (!/^[0-9a-f]{40,64}$/iu.test(commit)) {
    throw new CliOperationalError("Git returned an invalid base commit ID");
  }
  return commit;
}

async function lockfileChanged(
  commit: string,
  cwd: string,
  runtime: GitProcessRuntime,
): Promise<boolean> {
  return pathChanged(commit, cwd, LOCKFILE_NAME, runtime);
}

/**
 * Whether the working tree differs from the base commit at one path (tracked
 * diff, or a new untracked file). capdelta never parses the working-tree
 * content; Git compares it internally.
 */
export async function pathChanged(
  commit: string,
  cwd: string,
  path: string,
  runtime: GitProcessRuntime = {},
): Promise<boolean> {
  const tracked = await runGit(
    [
      "--literal-pathspecs",
      "diff",
      "--quiet",
      "--no-ext-diff",
      commit,
      "--",
      path,
    ],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
    runtime,
  );
  if (tracked.exitCode === 1) return true;
  if (tracked.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot compare ${path} with the base revision: ${gitDetail(tracked)}`,
    );
  }

  const untracked = await runGit(
    [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      path,
    ],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
    runtime,
  );
  if (untracked.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot inspect untracked ${path}: ${gitDetail(untracked)}`,
    );
  }
  return untracked.stdout.length > 0;
}

export async function readGitBaseLockfile(
  commit: string,
  cwd: string,
  maxBytes: number,
  runtime: GitProcessRuntime = {},
): Promise<string | null> {
  return readGitBaseFile(commit, cwd, LOCKFILE_NAME, maxBytes, runtime);
}

/**
 * Reads one cwd-relative path at an immutable commit: exactly one regular
 * blob entry, matched literally (no pathspec magic), read by object ID.
 * Returns null only when the path is absent at that commit.
 */
export async function readGitBaseFile(
  commit: string,
  cwd: string,
  path: string,
  maxBytes: number,
  runtime: GitProcessRuntime = {},
): Promise<string | null> {
  if (!isNormalizedRelativePosixPath(path)) {
    throw new CliOperationalError(
      `${JSON.stringify(path)} must be a normalized relative POSIX path`,
    );
  }
  const tree = await runGit(
    ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
    runtime,
  );
  if (tree.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot inspect base ${path}: ${gitDetail(tree)}`,
    );
  }
  if (tree.stdout.length === 0) return null;
  const metadata = decodeUtf8(tree.stdout, `base ${path} metadata`);
  const tab = metadata.indexOf("\t");
  const blobId =
    tab > 0 && metadata.slice(tab + 1) === `${path}\0`
      ? /^100\d{3} blob ([0-9a-f]{40,64})$/iu.exec(metadata.slice(0, tab))?.[1]
      : undefined;
  if (blobId === undefined) {
    throw new CliOperationalError(`base ${path} is not a regular Git blob`);
  }

  // Read the exact object whose mode and type were validated above. Using
  // `<commit>:<path>` here would resolve the path from the repository root,
  // while ls-tree and the head lockfile are relative to cwd.
  const shown = await runGit(
    ["cat-file", "blob", blobId],
    cwd,
    maxBytes,
    runtime,
  );
  if (shown.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot read base ${path}: ${gitDetail(shown)}`,
    );
  }
  return decodeUtf8(shown.stdout, `base ${path}`);
}

async function runGit(
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
  runtime: GitProcessRuntime,
): Promise<GitResult> {
  const commandTimeoutMs =
    runtime.commandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
  const terminationGraceMs =
    runtime.terminationGraceMs ?? DEFAULT_GIT_TERMINATION_GRACE_MS;
  if (
    !Number.isSafeInteger(commandTimeoutMs) ||
    commandTimeoutMs <= 0 ||
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs <= 0
  ) {
    throw new CliOperationalError(
      "Git command timeouts must be positive safe integers",
    );
  }

  return new Promise((resolveResult, reject) => {
    let child: GitChildProcess;
    try {
      child = (runtime.spawnImpl ?? spawn)("git", args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      reject(new CliOperationalError("cannot start Git", { cause: error }));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let pendingFailure: CliOperationalError | null = null;
    let terminationPhase: "none" | "soft" | "hard" = "none";
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;

    const rejectOnce = (error: CliOperationalError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      reject(error);
    };

    const abandonChild = (failure: CliOperationalError): void => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      rejectOnce(failure);
    };

    const hardTerminate = (failure: CliOperationalError): void => {
      if (settled || terminationPhase === "hard") return;
      terminationPhase = "hard";
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      let signalSent: boolean;
      try {
        signalSent = child.kill("SIGKILL");
      } catch (error: unknown) {
        abandonChild(
          new CliOperationalError(`${failure.message}; cannot hard-kill Git`, {
            cause: error,
          }),
        );
        return;
      }
      if (!signalSent) {
        abandonChild(
          new CliOperationalError(
            `${failure.message}; Git rejected the hard-kill signal`,
          ),
        );
        return;
      }
      terminationTimer = setTimeout(() => {
        abandonChild(
          new CliOperationalError(
            `${failure.message}; Git did not exit within ${String(terminationGraceMs)} ms after hard kill`,
          ),
        );
      }, terminationGraceMs);
      terminationTimer.unref();
    };

    const terminate = (failure: CliOperationalError): void => {
      if (settled || pendingFailure !== null) return;
      pendingFailure = failure;
      terminationPhase = "soft";
      clearTimeout(commandTimer);
      let signalSent: boolean;
      try {
        signalSent = child.kill();
      } catch (error: unknown) {
        abandonChild(
          new CliOperationalError(`${failure.message}; cannot terminate Git`, {
            cause: error,
          }),
        );
        return;
      }
      if (!signalSent) {
        hardTerminate(failure);
        return;
      }
      terminationTimer = setTimeout(() => {
        hardTerminate(failure);
      }, terminationGraceMs);
      terminationTimer.unref();
    };

    const commandTimer = setTimeout(() => {
      terminate(
        new CliOperationalError(
          `Git command timed out after ${String(commandTimeoutMs)} ms`,
        ),
      );
    }, commandTimeoutMs);
    commandTimer.unref();

    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (settled || pendingFailure !== null) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate(
          new CliOperationalError(
            `Git output exceeds the ${String(maxOutputBytes)} byte limit`,
          ),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    const handleChildError = (error: Error): void => {
      if (settled) return;
      if (pendingFailure === null) {
        abandonChild(
          new CliOperationalError("cannot start Git", { cause: error }),
        );
        return;
      }
      if (terminationPhase === "soft") {
        hardTerminate(pendingFailure);
        return;
      }
      abandonChild(
        new CliOperationalError(
          `${pendingFailure.message}; Git errored during hard kill`,
          { cause: error },
        ),
      );
    };
    // Keep this installed through soft and hard termination. ChildProcess may
    // emit more than one error while signals are escalated.
    child.on("error", handleChildError);
    child.once("close", (code) => {
      child.off("error", handleChildError);
      if (settled) return;
      if (pendingFailure !== null) {
        rejectOnce(pendingFailure);
        return;
      }
      settled = true;
      clearTimeout(commandTimer);
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function gitDetail(result: GitResult): string {
  const detail = decodeUtf8(result.stderr, "Git error output").trim();
  return detail.length === 0
    ? `Git exited ${String(result.exitCode)}`
    : truncate(detail, MAX_CLI_ERROR_CHARS);
}

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new CliOperationalError(`${description} is not valid UTF-8`, {
      cause: error,
    });
  }
}
