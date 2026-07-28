import { spawn } from "node:child_process";
import {
  CliOperationalError,
  MAX_CLI_ERROR_CHARS,
  truncateCliMessage,
} from "./cli-errors.js";

const LOCKFILE_NAME = "package-lock.json";
const GIT_METADATA_OUTPUT_BYTES = 1024 * 1024;

interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
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
): Promise<GitLockfileInspection> {
  const commit = await resolveBaseCommit(base, cwd);
  if (!(await lockfileChanged(commit, cwd))) return { changed: false };
  return { changed: true, commit };
}

async function resolveBaseCommit(base: string, cwd: string): Promise<string> {
  const result = await runGit(
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
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

async function lockfileChanged(commit: string, cwd: string): Promise<boolean> {
  const tracked = await runGit(
    ["diff", "--quiet", "--no-ext-diff", commit, "--", LOCKFILE_NAME],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (tracked.exitCode === 1) return true;
  if (tracked.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot compare ${LOCKFILE_NAME} with the base revision: ${gitDetail(tracked)}`,
    );
  }

  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard", "--", LOCKFILE_NAME],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (untracked.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot inspect untracked ${LOCKFILE_NAME}: ${gitDetail(untracked)}`,
    );
  }
  return untracked.stdout.length > 0;
}

export async function readGitBaseLockfile(
  commit: string,
  cwd: string,
  maxBytes: number,
): Promise<string | null> {
  const tree = await runGit(
    ["ls-tree", "-z", commit, "--", LOCKFILE_NAME],
    cwd,
    GIT_METADATA_OUTPUT_BYTES,
  );
  if (tree.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot inspect base ${LOCKFILE_NAME}: ${gitDetail(tree)}`,
    );
  }
  if (tree.stdout.length === 0) return null;
  const metadata = decodeUtf8(tree.stdout, `base ${LOCKFILE_NAME} metadata`);
  const blobId =
    /^100\d{3} blob ([0-9a-f]{40,64})\tpackage-lock\.json\0$/iu.exec(
      metadata,
    )?.[1];
  if (blobId === undefined) {
    throw new CliOperationalError(
      `base ${LOCKFILE_NAME} is not a regular Git blob`,
    );
  }

  // Read the exact object whose mode and type were validated above. Using
  // `<commit>:<path>` here would resolve the path from the repository root,
  // while ls-tree and the head lockfile are relative to cwd.
  const shown = await runGit(["cat-file", "blob", blobId], cwd, maxBytes);
  if (shown.exitCode !== 0) {
    throw new CliOperationalError(
      `cannot read base ${LOCKFILE_NAME}: ${gitDetail(shown)}`,
    );
  }
  return decodeUtf8(shown.stdout, `base ${LOCKFILE_NAME}`);
}

async function runGit(
  args: readonly string[],
  cwd: string,
  maxOutputBytes: number,
): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;

    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill();
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
    child.once("error", (error) => {
      reject(new CliOperationalError("cannot start Git", { cause: error }));
    });
    child.once("close", (code) => {
      if (outputExceeded) {
        reject(
          new CliOperationalError(
            `Git output exceeds the ${String(maxOutputBytes)} byte limit`,
          ),
        );
        return;
      }
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
    : truncateCliMessage(detail, MAX_CLI_ERROR_CHARS);
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
