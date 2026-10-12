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

async function goldenBytes(): Promise<{ oldBytes: Buffer; newBytes: Buffer }> {
  const [oldBytes, newBytes] = await Promise.all([
    readFile(join(GOLDEN_ROOT, "v1.tgz")),
    readFile(join(GOLDEN_ROOT, "v2.tgz")),
  ]);
  return { oldBytes, newBytes };
}

/** Serves inert golden tarballs by URL; anything else is a 404. */
function goldenFetch(oldBytes: Uint8Array, newBytes: Uint8Array): typeof fetch {
  const responses = new Map<string, Uint8Array>([
    [
      "https://registry.npmjs.org/golden-fixture/-/golden-fixture-1.0.0.tgz",
      oldBytes,
    ],
    [
      "https://registry.npmjs.org/golden-fixture/-/golden-fixture-2.0.0.tgz",
      newBytes,
    ],
  ]);
  return (input) => {
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
}

async function runInProcess(
  cwd: string,
  argv: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<ProcessResult & { order: ("stdout" | "stderr")[] }> {
  let stdout = "";
  let stderr = "";
  // Callback order, so tests can prove the report precedes gate diagnostics.
  const order: ("stdout" | "stderr")[] = [];
  const exitCode = await executeCli(argv, {
    cwd,
    stdout: (value) => {
      stdout += value;
      order.push("stdout");
    },
    stderr: (value) => {
      stderr += value;
      order.push("stderr");
    },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return { exitCode, stdout, stderr, order };
}

/** Commits `base` as HEAD, then leaves `head` as the working-tree lockfile. */
async function withBump<T>(
  base: Readonly<Record<string, unknown>>,
  head: Readonly<Record<string, unknown>>,
  body: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await createRepository(base);
  try {
    await writeLockfile(cwd, head);
    return await body(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
        schemaVersion: 5,
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

  it("returns exit 2 in strict mode when lockfile content is skipped", async () => {
    const cwd = await createRepository(emptyLockfile("strict"));
    try {
      await writeLockfile(cwd, {
        ...emptyLockfile("strict"),
        packages: {
          "": { name: "strict", version: "1.0.0" },
          "node_modules/private": {
            version: "1.0.0",
            resolved: "https://packages.example.invalid/private.tgz",
            integrity: "sha512-inert",
          },
        },
      });
      let stdout = "";
      let stderr = "";
      const exitCode = await executeCli(["--base", "HEAD", "--strict"], {
        cwd,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(exitCode).toBe(2);
      expect(stdout).toContain("Skipped lockfile entries:");
      expect(stderr).toContain("strict mode found unanalyzed content");
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
    const { oldBytes, newBytes } = await goldenBytes();
    const expectedText = await readFile(
      join(GOLDEN_ROOT, "expected-run.txt"),
      "utf8",
    );
    await withBump(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
      lockfileWithGolden("2.0.0", sri(newBytes)),
      async (cwd) => {
        const result = await runInProcess(
          cwd,
          ["--base", "HEAD"],
          goldenFetch(oldBytes, newBytes),
        );
        // The report is delivered in full before the default CRITICAL gate
        // fails the run (PLAN §4.5).
        expect(result).toEqual({
          exitCode: 1,
          stdout: expectedText,
          stderr:
            "capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)\n",
          order: ["stdout", "stderr"],
        });
      },
    );
  });

  it.each([
    { failOn: "none", exitCode: 0, stderr: "" },
    {
      failOn: "high",
      exitCode: 1,
      stderr: "capdelta: 2 finding(s) at or above HIGH (highest: CRITICAL)\n",
    },
  ])(
    "applies --fail-on $failOn to the golden bump",
    async ({ failOn, exitCode, stderr }) => {
      const { oldBytes, newBytes } = await goldenBytes();
      await withBump(
        lockfileWithGolden("1.0.0", sri(oldBytes)),
        lockfileWithGolden("2.0.0", sri(newBytes)),
        async (cwd) => {
          const result = await runInProcess(
            cwd,
            ["--base", "HEAD", "--fail-on", failOn],
            goldenFetch(oldBytes, newBytes),
          );
          expect(result.exitCode).toBe(exitCode);
          expect(result.stderr).toBe(stderr);
          expect(result.stdout).toContain(
            "Gate severity: CRITICAL: 1, HIGH: 1.",
          );
        },
      );
    },
  );

  it("passes the default gate below CRITICAL and fails an inclusive INFO gate", async () => {
    // A downgrade is an INFO lockfile finding; the 404 leaves the package
    // unavailable, which is incompleteness rather than a severity.
    const encoder = new TextEncoder();
    await withBump(
      lockfileWithGolden("2.0.0", sri(encoder.encode("inert v2"))),
      lockfileWithGolden("1.0.0", sri(encoder.encode("inert v1"))),
      async (cwd) => {
        const fetchNone: typeof fetch = () =>
          Promise.resolve(new Response("not found", { status: 404 }));
        const defaultGate = await runInProcess(
          cwd,
          ["--base", "HEAD"],
          fetchNone,
        );
        expect(defaultGate.exitCode).toBe(0);
        expect(defaultGate.stderr).toBe("");
        expect(defaultGate.stdout).toContain("[INFO] [version-downgrade]");
        expect(defaultGate.stdout).toContain("[fetch/http-status]");

        const infoGate = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "INFO"],
          fetchNone,
        );
        expect(infoGate.exitCode).toBe(1);
        expect(infoGate.stderr).toBe(
          "capdelta: 1 finding(s) at or above INFO (highest: INFO)\n",
        );
      },
    );
  });

  it("fails CRITICAL on an integrity mismatch and lets strict take precedence", async () => {
    const { oldBytes, newBytes } = await goldenBytes();
    const wrongIntegrity = sri(new TextEncoder().encode("not the tarball"));
    await withBump(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
      lockfileWithGolden("2.0.0", wrongIntegrity),
      async (cwd) => {
        const fetchImpl = goldenFetch(oldBytes, newBytes);
        const gated = await runInProcess(cwd, ["--base", "HEAD"], fetchImpl);
        expect(gated.exitCode).toBe(1);
        expect(gated.stdout).toContain("[CRITICAL] [fetch/integrity-mismatch]");
        expect(gated.stderr).toBe(
          "capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)\n",
        );

        const strict = await runInProcess(
          cwd,
          ["--base", "HEAD", "--strict"],
          fetchImpl,
        );
        expect(strict.exitCode).toBe(2);
        expect(strict.stderr).toBe(
          [
            "capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)",
            "capdelta: strict mode found unanalyzed content",
            "",
          ].join("\n"),
        );

        const reportOnlyStrict = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "none", "--strict"],
          fetchImpl,
        );
        expect(reportOnlyStrict.exitCode).toBe(2);
        expect(reportOnlyStrict.stderr).toBe(
          "capdelta: strict mode found unanalyzed content\n",
        );
      },
    );
  });

  it("keeps an allowlisted CRITICAL finding visible but out of the gate", async () => {
    const { oldBytes, newBytes } = await goldenBytes();
    await withBump(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
      lockfileWithGolden("2.0.0", sri(newBytes)),
      async (cwd) => {
        await writeFile(
          join(cwd, ".capdelta.yml"),
          'allowlist:\n  - package: golden-fixture\n    capability: INSTALL_HOOK\n    justification: "reviewed inert fixture hook"\n',
          "utf8",
        );
        const result = await runInProcess(
          cwd,
          ["--base", "HEAD", "--format", "json"],
          goldenFetch(oldBytes, newBytes),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const report = JSON.parse(result.stdout) as {
          summary: { bySeverity: object; gateSeverity: object };
          packages: { report: { findings: { suppression?: object }[] } }[];
        };
        expect(report.summary.bySeverity).toMatchObject({ CRITICAL: 1 });
        expect(report.summary.gateSeverity).toMatchObject({
          CRITICAL: 0,
          HIGH: 1,
        });
        expect(report.packages[0]?.report.findings[0]?.suppression).toEqual({
          reason: "reviewed inert fixture hook",
        });
      },
    );
  });

  it("rejects an invalid threshold before reading Git or the network", async () => {
    // A missing directory would make Git fail, and this fetch throws: a 64
    // exit proves parsing rejected the threshold before either was touched.
    const missingCwd = join(
      tmpdir(),
      `capdelta-missing-${String(process.pid)}`,
    );
    const unreachable: typeof fetch = () => {
      throw new Error("network must not be reached");
    };
    const result = await runInProcess(
      missingCwd,
      ["--base", "HEAD", "--fail-on", "urgent"],
      unreachable,
    );
    expect(result.exitCode).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "--fail-on must be CRITICAL, HIGH, MEDIUM, LOW, INFO, or none",
    );
  });
});
