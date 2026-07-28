import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { executeCli } from "./run-cli.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const GOLDEN_ROOT = fileURLToPath(
  new URL("../../test/fixtures/golden/install-script-added/", import.meta.url),
);

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

async function createRepository(
  lockfile: Readonly<Record<string, unknown>> | null,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "capdelta-cli-"));
  await git(cwd, "init", "--quiet");
  await git(cwd, "config", "user.email", "inert-fixture@example.invalid");
  await git(cwd, "config", "user.name", "Capdelta inert fixture");
  if (lockfile === null) {
    await writeFile(join(cwd, "README.md"), "inert fixture\n", "utf8");
  } else {
    await writeLockfile(cwd, lockfile);
  }
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "test: add inert baseline");
  return cwd;
}

async function writeLockfile(cwd: string, lockfile: unknown): Promise<void> {
  await writeFile(
    join(cwd, "package-lock.json"),
    `${JSON.stringify(lockfile, null, 2)}\n`,
    "utf8",
  );
}

function emptyLockfile(name: string): Readonly<Record<string, unknown>> {
  return {
    name,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name, version: "1.0.0" } },
  };
}

async function spawnCli(
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function lockfileWithGolden(
  version: "1.0.0" | "2.0.0",
  integrity: string,
): Readonly<Record<string, unknown>> {
  return {
    name: "inert-cli-project",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "inert-cli-project", version: "1.0.0" },
      "node_modules/golden-fixture": {
        version,
        resolved: `https://registry.npmjs.org/golden-fixture/-/golden-fixture-${version}.tgz`,
        integrity,
      },
    },
  };
}

describe("capdelta CLI", () => {
  it("runs the built executable and exposes the package bin help", async () => {
    const result = await spawnCli(process.cwd(), ["--help"]);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain(
      "Usage: capdelta --base <ref> [--format text|json]",
    );
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { bin?: { capdelta?: string } };
    expect(packageJson.bin?.capdelta).toBe("dist/cli.js");
  });

  it("takes the real no-op fast path with no process output", async () => {
    const cwd = await createRepository(emptyLockfile("unchanged"));
    try {
      const result = await spawnCli(cwd, ["--base", "HEAD"]);
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("retrieves the base lockfile with Git and emits JSON", async () => {
    const cwd = await createRepository(emptyLockfile("base-name"));
    try {
      await writeLockfile(cwd, emptyLockfile("head-name"));
      const result = await spawnCli(cwd, [
        "--base",
        "HEAD",
        "--format",
        "json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 3,
        firstRun: false,
        summary: {
          changedPackages: 0,
          analyzedPackages: 0,
          unavailablePackages: 0,
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads the validated cwd-relative base blob from a subdirectory", async () => {
    const cwd = await createRepository(emptyLockfile("root-baseline"));
    try {
      const app = join(cwd, "packages", "app");
      await mkdir(app, { recursive: true });
      await writeFile(join(cwd, "package-lock.json"), "{\n", "utf8");
      await writeLockfile(app, emptyLockfile("app-baseline"));
      await git(cwd, "add", ".");
      await git(
        cwd,
        "commit",
        "--quiet",
        "-m",
        "test: add inert subdirectory lockfile",
      );

      await writeLockfile(app, emptyLockfile("app-head"));
      const result = await spawnCli(app, [
        "--base",
        "HEAD",
        "--format",
        "json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        firstRun: false,
        summary: { changedPackages: 0 },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detects an untracked added lockfile as first-run mode", async () => {
    const cwd = await createRepository(null);
    try {
      await writeLockfile(cwd, emptyLockfile("first-run"));
      const result = await spawnCli(cwd, [
        "--base",
        "HEAD",
        "--format",
        "json",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        firstRun: true,
        summary: { changedPackages: 0 },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns stable usage and operational exit codes", async () => {
    const usage = await spawnCli(process.cwd(), []);
    expect(usage.exitCode).toBe(64);
    expect(usage.stderr).toContain("--base <ref> is required");

    const cwd = await createRepository(emptyLockfile("malformed"));
    try {
      await writeFile(join(cwd, "package-lock.json"), "{\n", "utf8");
      const malformed = await spawnCli(cwd, ["--base", "HEAD"]);
      expect(malformed.exitCode).toBe(1);
      expect(malformed.stdout).toBe("");
      expect(malformed.stderr).toContain(
        "head package-lock.json is not valid JSON",
      );

      await rm(join(cwd, "package-lock.json"));
      const missing = await spawnCli(cwd, ["--base", "HEAD"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toContain("cannot inspect head package-lock.json");
      expect(missing.stderr).toMatch(/caused by .*ENOENT/u);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs the inert golden package through the complete CLI pipeline", async () => {
    const [oldBytes, newBytes, expectedText] = await Promise.all([
      readFile(join(GOLDEN_ROOT, "v1.tgz")),
      readFile(join(GOLDEN_ROOT, "v2.tgz")),
      readFile(join(GOLDEN_ROOT, "expected-run.txt"), "utf8"),
    ]);
    const oldUrl =
      "https://registry.npmjs.org/golden-fixture/-/golden-fixture-1.0.0.tgz";
    const newUrl =
      "https://registry.npmjs.org/golden-fixture/-/golden-fixture-2.0.0.tgz";
    const responses = new Map<string, Uint8Array>([
      [oldUrl, oldBytes],
      [newUrl, newBytes],
    ]);
    const fetchImpl: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      const bytes = responses.get(url);
      if (bytes === undefined) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        }),
      );
    };

    const cwd = await createRepository(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
    );
    try {
      await writeLockfile(cwd, lockfileWithGolden("2.0.0", sri(newBytes)));
      let stdout = "";
      let stderr = "";
      const exitCode = await executeCli(["--base", "HEAD"], {
        cwd,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
        fetchImpl,
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe(expectedText);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
