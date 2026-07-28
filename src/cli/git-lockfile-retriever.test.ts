import {
  execFile,
  type ChildProcessByStdio,
  type spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliOperationalError } from "./cli-errors.js";
import {
  inspectGitLockfileChange,
  readGitBaseLockfile,
} from "./git-lockfile-retriever.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const BASE_LOCKFILE =
  '{"name":"inert","version":"1.0.0","lockfileVersion":3,"packages":{}}\n';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

async function createRepository(withLockfile: boolean): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "capdelta-git-retriever-"));
  roots.push(cwd);
  await git(cwd, "init", "--quiet");
  await git(cwd, "config", "user.email", "inert-fixture@example.invalid");
  await git(cwd, "config", "user.name", "Capdelta inert fixture");
  await writeFile(
    join(cwd, withLockfile ? "package-lock.json" : "README.md"),
    withLockfile ? BASE_LOCKFILE : "inert fixture\n",
    "utf8",
  );
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "test: add inert baseline");
  return cwd;
}

type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

function fakeGitProcess(
  closeOn: "soft" | "hard" | "never" = "soft",
  softSignalAccepted = true,
  errorOnSoft = false,
): {
  spawnImpl: typeof spawn;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  unref: ReturnType<typeof vi.fn>;
} {
  const stdout = new PassThrough();
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    stdin: null,
    stdout,
    stderr: new PassThrough(),
    unref,
  }) as unknown as GitChildProcess;
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    const hard = signal === "SIGKILL";
    if (!hard && !softSignalAccepted) return false;
    if (!hard && errorOnSoft) {
      queueMicrotask(() => child.emit("error", new Error("kill failed")));
    }
    if ((hard && closeOn === "hard") || (!hard && closeOn === "soft")) {
      queueMicrotask(() => child.emit("close", null));
    }
    return true;
  });
  child.kill = kill;
  const spawnImpl = vi.fn(() => {
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, kill, stdout, unref };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Git lockfile retriever", () => {
  it("takes the no-op path for an unchanged lockfile", async () => {
    const cwd = await createRepository(true);
    await expect(inspectGitLockfileChange("HEAD", cwd)).resolves.toEqual({
      changed: false,
    });
  });

  it("reads the exact base blob after detecting a change", async () => {
    const cwd = await createRepository(true);
    await writeFile(
      join(cwd, "package-lock.json"),
      BASE_LOCKFILE.replace("1.0.0", "2.0.0"),
      "utf8",
    );

    const inspection = await inspectGitLockfileChange("HEAD", cwd);
    expect(inspection.changed).toBe(true);
    if (!inspection.changed) throw new Error("expected a changed lockfile");
    await expect(
      readGitBaseLockfile(inspection.commit, cwd, 1024),
    ).resolves.toBe(BASE_LOCKFILE);
  });

  it("represents an added lockfile with a null base", async () => {
    const cwd = await createRepository(false);
    await writeFile(join(cwd, "package-lock.json"), BASE_LOCKFILE, "utf8");

    const inspection = await inspectGitLockfileChange("HEAD", cwd);
    expect(inspection.changed).toBe(true);
    if (!inspection.changed) throw new Error("expected an added lockfile");
    await expect(
      readGitBaseLockfile(inspection.commit, cwd, 1024),
    ).resolves.toBeNull();
  });

  it("degrades loudly when the validated blob exceeds its limit", async () => {
    const cwd = await createRepository(true);
    const commit = (await git(cwd, "rev-parse", "HEAD")).trim();
    await expect(readGitBaseLockfile(commit, cwd, 1)).rejects.toBeInstanceOf(
      CliOperationalError,
    );
  });

  it("terminates and rejects a stalled Git command at its deadline", async () => {
    const { spawnImpl, kill } = fakeGitProcess("hard");
    await expect(
      inspectGitLockfileChange("HEAD", process.cwd(), {
        spawnImpl,
        commandTimeoutMs: 5,
        terminationGraceMs: 5,
      }),
    ).rejects.toThrow("Git command timed out after 5 ms");
    expect(kill).toHaveBeenNthCalledWith(1);
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("terminates and rejects immediately when Git output exceeds its cap", async () => {
    const { spawnImpl, kill, stdout } = fakeGitProcess();
    const inspection = inspectGitLockfileChange("HEAD", process.cwd(), {
      spawnImpl,
    });
    stdout.write(Buffer.alloc(1024 * 1024 + 1));
    await expect(inspection).rejects.toThrow(
      "Git output exceeds the 1048576 byte limit",
    );
    expect(kill).toHaveBeenCalledOnce();
  });

  it("hard-kills immediately when Git rejects soft termination", async () => {
    const { spawnImpl, kill, stdout } = fakeGitProcess("hard", false);
    const inspection = inspectGitLockfileChange("HEAD", process.cwd(), {
      spawnImpl,
    });
    stdout.write(Buffer.alloc(1024 * 1024 + 1));
    await expect(inspection).rejects.toThrow(
      "Git output exceeds the 1048576 byte limit",
    );
    expect(kill).toHaveBeenNthCalledWith(1);
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("keeps escalation active when soft termination emits error without close", async () => {
    const { spawnImpl, kill, stdout, unref } = fakeGitProcess(
      "never",
      true,
      true,
    );
    const inspection = inspectGitLockfileChange("HEAD", process.cwd(), {
      spawnImpl,
      terminationGraceMs: 5,
    });
    stdout.write(Buffer.alloc(1024 * 1024 + 1));
    await expect(inspection).rejects.toThrow(
      "Git did not exit within 5 ms after hard kill",
    );
    expect(kill).toHaveBeenNthCalledWith(1);
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(unref).toHaveBeenCalledOnce();
  });
});
