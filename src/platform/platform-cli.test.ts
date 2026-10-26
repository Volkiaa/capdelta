import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewers, hashToken } from "./intel/reviewers.js";
import { runPlatformCli, type PlatformCliIo } from "./platform-cli.js";
import { createFakeRegistry, REGISTRY_ORIGIN } from "./test-registry.js";

const REGISTRY = "https://registry.npmjs.org";

let base: string;
let dataDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-platform-cli-"));
  dataDir = join(base, "data");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(base, { recursive: true, force: true });
});

function capture(signal?: AbortSignal): {
  io: PlatformCliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => {
        stdout.push(value);
      },
      stderr: (value) => {
        stderr.push(value);
      },
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

/** The CLI passes no fetchImpl, so the collector takes it from the global. */
function stubRegistry(): void {
  const fetchImpl: typeof fetch = (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url === `${REGISTRY}/alpha`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            name: "alpha",
            versions: {
              "1.0.0": {
                name: "alpha",
                version: "1.0.0",
                dist: {
                  integrity: "sha512-alpha-one",
                  tarball: `${REGISTRY}/alpha/-/alpha-1.0.0.tgz`,
                },
              },
            },
            time: {
              created: "2026-01-01T00:00:00.000Z",
              "1.0.0": "2026-01-01T00:00:00.000Z",
            },
          }),
        ),
      );
    }
    throw new Error(`unexpected request: ${url}`);
  };
  vi.stubGlobal("fetch", fetchImpl);
}

describe("runPlatformCli", () => {
  it("prints usage for --help and exits 0", async () => {
    const { io, stdout, stderr } = capture();

    const code = await runPlatformCli(["--help"], io);

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("usage: capdelta-platform");
    expect(stdout.join("")).toContain("monitor");
    expect(stderr).toEqual([]);
  });

  it("rejects an unknown command with usage on stderr and exit 2", async () => {
    const { io, stdout, stderr } = capture();

    const code = await runPlatformCli(["bogus"], io);

    expect(code).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain('unknown command "bogus"');
    expect(stderr.join("")).toContain("usage: capdelta-platform");
  });

  it("rejects a missing required flag with usage on stderr and exit 2", async () => {
    const { io, stderr } = capture();

    const code = await runPlatformCli(["analyze", "--data", dataDir], io);

    expect(code).toBe(2);
    expect(stderr.join("")).toContain("analyze requires --package");
    expect(stderr.join("")).toContain("usage: capdelta-platform");
  });

  it("reports an unknown version on stderr and exits 1", async () => {
    stubRegistry();
    const { io, stdout, stderr } = capture();

    const code = await runPlatformCli(
      [
        "analyze",
        "--data",
        dataDir,
        "--package",
        "alpha",
        "--version",
        "9.9.9",
      ],
      io,
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toMatch(/^error: /u);
    expect(stderr.join("")).toContain("alpha@9.9.9");
  });

  it("serves the API and prints the listening address", async () => {
    const controller = new AbortController();
    const stdout: string[] = [];

    const code = await runPlatformCli(
      ["serve", "--data", dataDir, "--port", "0"],
      {
        stdout: (value) => {
          stdout.push(value);
          controller.abort();
        },
        stderr: () => undefined,
        signal: controller.signal,
      },
    );

    expect(code).toBe(0);
    expect(stdout.join("")).toMatch(/^listening on 127\.0\.0\.1:\d+\n$/u);
  });

  it("serves with a valid reviewers file", async () => {
    const file = join(base, "reviewers.json");
    await writeFile(
      file,
      JSON.stringify({ [hashToken("alice-token")]: "alice" }),
      "utf8",
    );
    const controller = new AbortController();
    const stdout: string[] = [];

    const code = await runPlatformCli(
      ["serve", "--data", dataDir, "--port", "0", "--reviewers", file],
      {
        stdout: (value) => {
          stdout.push(value);
          controller.abort();
        },
        stderr: () => undefined,
        signal: controller.signal,
      },
    );

    expect(code).toBe(0);
    expect(stdout.join("")).toMatch(/^listening on 127\.0\.0\.1:\d+\n$/u);
  });

  it("refuses to serve with a bad reviewers file", async () => {
    const file = join(base, "reviewers.json");
    await writeFile(file, "{", "utf8");
    const { io, stdout, stderr } = capture();

    const code = await runPlatformCli(
      ["serve", "--data", dataDir, "--port", "0", "--reviewers", file],
      io,
    );

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^error: /u);
  });

  it("prints a reviewer token and the entry that authenticates it", async () => {
    const { io, stdout, stderr } = capture();

    const code = await runPlatformCli(
      ["reviewer-token", "--name", "alice"],
      io,
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const lines = stdout.join("").split("\n");
    expect(lines).toHaveLength(3);
    const [token, entry] = lines;
    expect(token).toMatch(/^cdr_[A-Za-z0-9_-]{43}$/u);
    if (token === undefined) throw new Error("expected a token");
    expect(entry).toBe(`${JSON.stringify(hashToken(token))}: "alice"`);
    expect(
      createReviewers({ [hashToken(token)]: "alice" }).authenticate(token),
    ).toBe("alice");
  });

  it("rejects a reviewer name the file parser would reject", async () => {
    for (const name of ["analyzer", "   ", "a".repeat(161)]) {
      const { io, stdout } = capture();

      const code = await runPlatformCli(["reviewer-token", "--name", name], io);

      expect(code).toBe(2);
      expect(stdout).toEqual([]);
    }
  });

  it("rejects an invalid --concurrency on monitor and analyze", async () => {
    for (const command of ["monitor", "analyze"]) {
      for (const value of ["0", "17", "1.5", "NaN"]) {
        const { io, stdout, stderr } = capture();
        const args =
          command === "monitor"
            ? [command, "--data", dataDir, "--concurrency", value]
            : [
                command,
                "--data",
                dataDir,
                "--package",
                "alpha",
                "--version",
                "1.0.0",
                "--concurrency",
                value,
              ];

        const code = await runPlatformCli(args, io);

        expect(code).toBe(2);
        expect(stdout).toEqual([]);
        expect(stderr.join("")).toContain(
          "--concurrency must be an integer between 1 and 16",
        );
      }
    }
  });

  it("analyzes with --concurrency 2 through the test registry", async () => {
    const registry = createFakeRegistry();
    registry.publish("alpha", "1.0.0");
    vi.stubGlobal("fetch", registry.fetchImpl);
    const { io, stdout, stderr } = capture();

    const code = await runPlatformCli(
      [
        "analyze",
        "--data",
        dataDir,
        "--package",
        "alpha",
        "--version",
        "1.0.0",
        "--concurrency",
        "2",
        "--registry",
        REGISTRY_ORIGIN,
      ],
      io,
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("")).toBe("analyze: analyzed 1, failed 0\n");
    expect(registry.tarballRequestCount()).toBe(1);
  });
});
