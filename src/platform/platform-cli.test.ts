import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlatformCli, type PlatformCliIo } from "./platform-cli.js";

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
});
