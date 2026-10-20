import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "../core/capability-analysis-pipeline.js";
import type { CapabilityDiffResult } from "../core/capability-differ.js";
import { parseCapdeltaConfig } from "../core/capdelta-config.js";
import { applyUnanalyzableExceptions } from "../core/unanalyzable-exceptions.js";
import { executeCli, type CliRuntime } from "./run-cli.js";

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

const OLD_INTEGRITY =
  "sha512-BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw==";
const NEW_INTEGRITY =
  "sha512-CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==";

// ADR-019
const MIXED_FAILURES: [PackageAnalysisFailure, ...PackageAnalysisFailure[]] = [
  {
    stage: "old-manifest",
    failure: {
      kind: "manifest-unreadable",
      detail: "package.json could not be read: EACCES",
      evidence: null,
    },
  },
  {
    stage: "new-extraction",
    failure: {
      kind: "invalid-archive",
      detail: "tar archive could not be processed",
    },
  },
];

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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
  analyze?: CliRuntime["analyze"],
): Promise<ProcessResult & { order: ("stdout" | "stderr")[] }> {
  let stdout = "";
  let stderr = "";
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
    ...(sleep === undefined ? {} : { sleep }),
    ...(analyze === undefined ? {} : { analyze }),
  });
  return { exitCode, stdout, stderr, order };
}

// ADR-018
const instantSleep = (): Promise<void> => Promise.resolve();

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

// ADR-019
function unavailableRun(
  failures: readonly [PackageAnalysisFailure, ...PackageAnalysisFailure[]],
): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
    packages: [
      {
        status: "unavailable",
        changedPackage: {
          name: "unreadable-fixture",
          oldVersion: "1.0.0",
          newVersion: "2.0.0",
          oldIntegrity: OLD_INTEGRITY,
          newIntegrity: NEW_INTEGRITY,
          oldResolvedUrl:
            "https://registry.npmjs.org/unreadable-fixture/-/unreadable-fixture-1.0.0.tgz",
          resolvedUrl:
            "https://registry.npmjs.org/unreadable-fixture/-/unreadable-fixture-2.0.0.tgz",
        },
        failures,
      },
    ],
    lockfileFindings: [],
    skipped: [],
  };
}

// ADR-019
function analyzeRun(
  run: CapabilityAnalysisRun,
): NonNullable<CliRuntime["analyze"]> {
  return () => Promise.resolve(run);
}

const EMPTY_DIFF: CapabilityDiffResult = {
  baseline: { ecosystem: "npm", name: "cleanup-fixture", version: "1.0.0" },
  subject: { ecosystem: "npm", name: "cleanup-fixture", version: "2.0.0" },
  newPackage: false,
  findings: [],
  diagnostics: [],
};

function analyzedRun(
  issues: readonly PackageAnalysisFailure[],
): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
    packages: [
      {
        status: "analyzed",
        changedPackage: {
          name: "cleanup-fixture",
          oldVersion: "1.0.0",
          newVersion: "2.0.0",
          oldIntegrity: OLD_INTEGRITY,
          newIntegrity: NEW_INTEGRITY,
          oldResolvedUrl:
            "https://registry.npmjs.org/cleanup-fixture/-/cleanup-fixture-1.0.0.tgz",
          resolvedUrl:
            "https://registry.npmjs.org/cleanup-fixture/-/cleanup-fixture-2.0.0.tgz",
        },
        diff: EMPTY_DIFF,
        issues,
        baselineFailures: [],
      },
    ],
    lockfileFindings: [],
    skipped: [],
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
    await withBump(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
      lockfileWithGolden("2.0.0", sri(newBytes)),
      async (cwd) => {
        const result = await runInProcess(
          cwd,
          ["--base", "HEAD"],
          goldenFetch(oldBytes, newBytes),
        );
        // PLAN §4.5
        const { stdout, ...rest } = result;
        expect(rest).toEqual({
          exitCode: 1,
          stderr:
            "capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)\n",
          order: ["stdout", "stderr"],
        });
        await expect(stdout).toMatchFileSnapshot(
          join(GOLDEN_ROOT, "expected-run.txt"),
        );
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

  it("fails CRITICAL on a non-retryable HTTP status (ADR-018 decision 3)", async () => {
    const encoder = new TextEncoder();
    await withBump(
      lockfileWithGolden("2.0.0", sri(encoder.encode("inert v2"))),
      lockfileWithGolden("1.0.0", sri(encoder.encode("inert v1"))),
      async (cwd) => {
        let calls = 0;
        const fetch404: typeof fetch = () => {
          calls += 1;
          return Promise.resolve(new Response("not found", { status: 404 }));
        };
        const result = await runInProcess(cwd, ["--base", "HEAD"], fetch404);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain(
          "[CRITICAL] could not analyze: [fetch/http-status]",
        );
        expect(result.stdout).toContain("[INFO] [version-downgrade]");
        expect(result.stderr).toBe(
          "capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)\n",
        );
        expect(calls).toBe(1);
      },
    );
  });

  it("fails operationally on an exhausted transient fetch, even with --fail-on none (ADR-018)", async () => {
    const encoder = new TextEncoder();
    await withBump(
      lockfileWithGolden("2.0.0", sri(encoder.encode("inert v2"))),
      lockfileWithGolden("1.0.0", sri(encoder.encode("inert v1"))),
      async (cwd) => {
        let calls = 0;
        const fetch503: typeof fetch = () => {
          calls += 1;
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        };
        const message =
          "capdelta: 1 package(s) could not be fetched or analyzed\n";

        const defaultGate = await runInProcess(
          cwd,
          ["--base", "HEAD"],
          fetch503,
          instantSleep,
        );
        expect(defaultGate.exitCode).toBe(1);
        expect(defaultGate.stdout).toContain("[fetch/http-unavailable]");
        expect(defaultGate.stdout).toContain("[INFO] [version-downgrade]");
        expect(defaultGate.stderr).toBe(message);
        expect(calls).toBe(3);

        const reportOnly = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "none"],
          fetch503,
          instantSleep,
        );
        expect(reportOnly.exitCode).toBe(1);
        expect(reportOnly.stderr).toBe(message);

        const infoGate = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "INFO"],
          fetch503,
          instantSleep,
        );
        expect(infoGate.exitCode).toBe(1);
        expect(infoGate.stderr).toBe(
          "capdelta: 1 finding(s) at or above INFO (highest: INFO)\n" + message,
        );
        expect(infoGate.order).toEqual(["stdout", "stderr", "stderr"]);

        const strict = await runInProcess(
          cwd,
          ["--base", "HEAD", "--strict"],
          fetch503,
          instantSleep,
        );
        expect(strict.exitCode).toBe(2);
        expect(strict.stderr).toBe(
          `${message}capdelta: strict mode found unanalyzed content\n`,
        );

        const strictBoth = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "INFO", "--strict"],
          fetch503,
          instantSleep,
        );
        expect(strictBoth.exitCode).toBe(2);
        expect(strictBoth.stderr).toBe(
          "capdelta: 1 finding(s) at or above INFO (highest: INFO)\n" +
            message +
            "capdelta: strict mode found unanalyzed content\n",
        );
        expect(strictBoth.order).toEqual([
          "stdout",
          "stderr",
          "stderr",
          "stderr",
        ]);
      },
    );
  });

  it.each(["old-extraction", "new-extraction"] as const)(
    "fails operationally on a %s filesystem-error, even with --fail-on none (ADR-019)",
    async (stage) => {
      const analyze = analyzeRun(
        unavailableRun([
          {
            stage,
            failure: { kind: "filesystem-error", detail: "input/output error" },
          },
        ]),
      );
      const message =
        "capdelta: 1 package(s) could not be fetched or analyzed\n";
      await withBump(
        emptyLockfile("filesystem-base"),
        emptyLockfile("filesystem-head"),
        async (cwd) => {
          const gated = await runInProcess(
            cwd,
            ["--base", "HEAD"],
            undefined,
            undefined,
            analyze,
          );
          expect(gated.exitCode).toBe(1);
          expect(gated.stderr).toBe(message);

          const reportOnly = await runInProcess(
            cwd,
            ["--base", "HEAD", "--fail-on", "none"],
            undefined,
            undefined,
            analyze,
          );
          expect(reportOnly.exitCode).toBe(1);
          expect(reportOnly.stderr).toBe(message);

          const strict = await runInProcess(
            cwd,
            ["--base", "HEAD", "--strict"],
            undefined,
            undefined,
            analyze,
          );
          expect(strict.exitCode).toBe(2);
          expect(strict.stderr).toBe(
            `${message}capdelta: strict mode found unanalyzed content\n`,
          );
        },
      );
    },
  );

  it.each(["old-manifest", "new-manifest"] as const)(
    "fails operationally on a %s manifest-unreadable, even with --fail-on none (ADR-019)",
    async (stage) => {
      const analyze = analyzeRun(
        unavailableRun([
          {
            stage,
            failure: {
              kind: "manifest-unreadable",
              detail: "package.json could not be read: EACCES",
              evidence: null,
            },
          },
        ]),
      );
      const message =
        "capdelta: 1 package(s) could not be fetched or analyzed\n";
      await withBump(
        emptyLockfile("manifest-base"),
        emptyLockfile("manifest-head"),
        async (cwd) => {
          const gated = await runInProcess(
            cwd,
            ["--base", "HEAD"],
            undefined,
            undefined,
            analyze,
          );
          expect(gated.exitCode).toBe(1);
          expect(gated.stderr).toBe(message);

          const reportOnly = await runInProcess(
            cwd,
            ["--base", "HEAD", "--fail-on", "none"],
            undefined,
            undefined,
            analyze,
          );
          expect(reportOnly.exitCode).toBe(1);
          expect(reportOnly.stderr).toBe(message);

          const strict = await runInProcess(
            cwd,
            ["--base", "HEAD", "--strict"],
            undefined,
            undefined,
            analyze,
          );
          expect(strict.exitCode).toBe(2);
          expect(strict.stderr).toBe(
            `${message}capdelta: strict mode found unanalyzed content\n`,
          );
        },
      );
    },
  );

  it("counts a mixed manifest-unreadable plus CRITICAL package once (ADR-019)", async () => {
    const analyze = analyzeRun(unavailableRun(MIXED_FAILURES));
    const message = "capdelta: 1 package(s) could not be fetched or analyzed\n";
    await withBump(
      emptyLockfile("mixed-base"),
      emptyLockfile("mixed-head"),
      async (cwd) => {
        const gated = await runInProcess(
          cwd,
          ["--base", "HEAD"],
          undefined,
          undefined,
          analyze,
        );
        expect(gated.exitCode).toBe(1);
        expect(gated.stderr).toBe(
          `capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)\n${message}`,
        );
        expect(gated.stdout).toContain(
          "[CRITICAL] could not analyze: [new-extraction/invalid-archive]",
        );

        const reportOnly = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "none"],
          undefined,
          undefined,
          analyze,
        );
        expect(reportOnly.exitCode).toBe(1);
        expect(reportOnly.stderr).toBe(message);
      },
    );
  });

  it("builds a reviewed exception through the real config path; it releases the gate but not the operational exit (ADR-019)", async () => {
    // ADR-017
    const config = parseCapdeltaConfig(
      "unanalyzable:\n" +
        "  - package: unreadable-fixture\n" +
        "    version: 2.0.0\n" +
        `    integrity: ${NEW_INTEGRITY}\n` +
        "    kind: invalid-archive\n" +
        '    justification: "reviewed inert invalid archive"\n',
    );
    const run = applyUnanalyzableExceptions(
      unavailableRun(MIXED_FAILURES),
      config,
    );
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    expect(item.exception).toEqual({
      reason: "[version 2.0.0] reviewed inert invalid archive",
    });

    const message = "capdelta: 1 package(s) could not be fetched or analyzed\n";
    await withBump(
      emptyLockfile("mixed-base"),
      emptyLockfile("mixed-head"),
      async (cwd) => {
        const analyze = analyzeRun(run);
        const gated = await runInProcess(
          cwd,
          ["--base", "HEAD", "--format", "json"],
          undefined,
          undefined,
          analyze,
        );
        expect(gated.exitCode).toBe(1);
        expect(gated.stderr).toBe(message);
        expect(gated.stdout).toContain(
          "[version 2.0.0] reviewed inert invalid archive",
        );
        const report = JSON.parse(gated.stdout) as {
          summary: { gateSeverity: { CRITICAL: number } };
        };
        expect(report.summary.gateSeverity.CRITICAL).toBe(0);

        const strict = await runInProcess(
          cwd,
          ["--base", "HEAD", "--strict"],
          undefined,
          undefined,
          analyze,
        );
        expect(strict.exitCode).toBe(2);
        expect(strict.stderr).toBe(
          `${message}capdelta: strict mode found unanalyzed content\n`,
        );
      },
    );
  });

  it("exits 0 for a cleanup-only warning on an analyzed package (ADR-019)", async () => {
    const analyze = analyzeRun(
      analyzedRun([
        {
          stage: "old-cleanup",
          failure: { kind: "cleanup-failed", detail: "cleanup failed" },
        },
      ]),
    );
    await withBump(
      emptyLockfile("cleanup-base"),
      emptyLockfile("cleanup-head"),
      async (cwd) => {
        const result = await runInProcess(
          cwd,
          ["--base", "HEAD"],
          undefined,
          undefined,
          analyze,
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("[old-cleanup/cleanup-failed]");
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

  it("fails the default gate on an unanalyzable package and lets strict take precedence", async () => {
    // ADR-016
    const { oldBytes } = await goldenBytes();
    const brokenBytes = new TextEncoder().encode("inert, not a tarball");
    await withBump(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
      lockfileWithGolden("2.0.0", sri(brokenBytes)),
      async (cwd) => {
        const fetchImpl = goldenFetch(oldBytes, brokenBytes);

        const gated = await runInProcess(cwd, ["--base", "HEAD"], fetchImpl);
        expect(gated.exitCode).toBe(1);
        expect(gated.stdout).toContain(
          "[CRITICAL] could not analyze: [new-extraction/invalid-archive]",
        );
        expect(gated.stderr).toBe(
          "capdelta: 1 finding(s) at or above CRITICAL (highest: CRITICAL)\n",
        );
        expect(gated.order).toEqual(["stdout", "stderr"]);

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
        expect(strict.order).toEqual(["stdout", "stderr", "stderr"]);
      },
    );
  });

  it("releases a reviewed unanalyzable exception; strict still returns 2 (ADR-017)", async () => {
    // ADR-016
    const { oldBytes } = await goldenBytes();
    const brokenBytes = new TextEncoder().encode("inert, not a tarball");
    const cwd = await createRepository(
      lockfileWithGolden("1.0.0", sri(oldBytes)),
    );
    try {
      await writeFile(
        join(cwd, ".capdelta.yml"),
        "unanalyzable:\n" +
          "  - package: golden-fixture\n" +
          "    version: 2.0.0\n" +
          `    integrity: ${sri(brokenBytes)}\n` +
          "    kind: invalid-archive\n" +
          '    justification: "reviewed inert broken fixture"\n',
        "utf8",
      );
      await git(cwd, "add", ".");
      await git(cwd, "commit", "--quiet", "-m", "test: reviewed exception");
      await writeLockfile(cwd, lockfileWithGolden("2.0.0", sri(brokenBytes)));
      const fetchImpl = goldenFetch(oldBytes, brokenBytes);

      const gated = await runInProcess(cwd, ["--base", "HEAD"], fetchImpl);
      expect(gated.exitCode).toBe(0);
      expect(gated.stderr).toBe("");
      expect(gated.stdout).toContain("reviewed exception:");
      expect(gated.stdout).toContain("reviewed inert broken fixture");

      const strict = await runInProcess(
        cwd,
        ["--base", "HEAD", "--strict"],
        fetchImpl,
      );
      expect(strict.exitCode).toBe(2);
      expect(strict.stderr).toContain("strict mode found unanalyzed content");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  describe("allowlist policy comes from the base commit (ADR-015)", () => {
    const EXCEPTION =
      'allowlist:\n  - package: golden-fixture\n    capability: INSTALL_HOOK\n    version: 2.0.0\n    justification: "reviewed inert fixture hook"\n';

    async function scenario(
      baseConfig: string | null,
      body: (cwd: string, fetchImpl: typeof fetch) => Promise<void>,
      configDir = "",
    ): Promise<void> {
      const { oldBytes, newBytes } = await goldenBytes();
      const cwd = await createRepository(
        lockfileWithGolden("1.0.0", sri(oldBytes)),
      );
      try {
        if (baseConfig !== null) {
          await mkdir(join(cwd, configDir), { recursive: true });
          await writeFile(
            join(cwd, configDir, ".capdelta.yml"),
            baseConfig,
            "utf8",
          );
          await git(cwd, "add", ".");
          await git(cwd, "commit", "--quiet", "-m", "test: reviewed exception");
        }
        await writeLockfile(cwd, lockfileWithGolden("2.0.0", sri(newBytes)));
        await body(cwd, goldenFetch(oldBytes, newBytes));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }

    it("ignores an exception that exists only in the working tree", async () => {
      await scenario(null, async (cwd, fetchImpl) => {
        await writeFile(join(cwd, ".capdelta.yml"), EXCEPTION, "utf8");
        const result = await runInProcess(
          cwd,
          ["--base", "HEAD", "--format", "json"],
          fetchImpl,
        );
        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain("reviewed inert fixture hook");
        expect(result.stderr).toContain(".capdelta.yml differs from base");
        expect(result.stderr).toContain("is not present at base");
      });
    });

    it("applies the exception committed at base, even if the working tree removes it", async () => {
      await scenario(EXCEPTION, async (cwd, fetchImpl) => {
        const clean = await runInProcess(
          cwd,
          ["--base", "HEAD", "--format", "json"],
          fetchImpl,
        );
        expect(clean.exitCode).toBe(0);
        expect(clean.stderr).toBe("");
        const report = JSON.parse(clean.stdout) as {
          summary: { gateSeverity: { CRITICAL: number } };
        };
        expect(report.summary.gateSeverity.CRITICAL).toBe(0);
        expect(clean.stdout).toContain(
          "[version 2.0.0] reviewed inert fixture hook",
        );

        await rm(join(cwd, ".capdelta.yml"));
        const edited = await runInProcess(
          cwd,
          ["--base", "HEAD", "--format", "json"],
          fetchImpl,
        );
        expect(edited.exitCode).toBe(0);
        expect(edited.stderr).toContain(".capdelta.yml differs from base");
      });
    });

    it("resolves the config path relative to the CLI's cwd", async () => {
      await scenario(
        EXCEPTION,
        async (cwd, fetchImpl) => {
          const result = await runInProcess(
            cwd,
            ["--base", "HEAD", "--config", "policy/.capdelta.yml"],
            fetchImpl,
          );
          expect(result.exitCode).toBe(0);
        },
        "policy",
      );
    });

    it("warns for an explicit config missing at base and stays quiet for the default", async () => {
      await scenario(null, async (cwd, fetchImpl) => {
        const implicit = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "none"],
          fetchImpl,
        );
        expect(implicit.stderr).toBe("");
        const explicit = await runInProcess(
          cwd,
          ["--base", "HEAD", "--fail-on", "none", "--config", "missing.yml"],
          fetchImpl,
        );
        expect(explicit.stderr).toContain("missing.yml is not present at base");
      });
    });

    it("fails on an invalid base config or an unsafe config path", async () => {
      await scenario("allowlist:\n  - package: x\n", async (cwd, fetchImpl) => {
        const invalid = await runInProcess(cwd, ["--base", "HEAD"], fetchImpl);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr).toContain(
          "base config .capdelta.yml is invalid",
        );
        for (const unsafe of ["../outside.yml", "/etc/capdelta.yml"]) {
          const result = await runInProcess(
            cwd,
            ["--base", "HEAD", "--config", unsafe],
            fetchImpl,
          );
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            "must be a normalized relative POSIX path",
          );
        }
      });
    });
  });

  it("rejects an invalid threshold before reading Git or the network", async () => {
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
