import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { parseCapdeltaConfig } from "../core/capdelta-config.js";
import { buildRunReport } from "../core/reporter.js";
import { evaluateSeverityGate } from "../core/run-severity.js";
import { analyzeLockfiles } from "./run-action.js";

// ADR-0043: an allowlisted mirror is analyzed through the same fetch and SRI
// checks as registry.npmjs.org. Fixtures are inert text, never executed.
const HOST = "npm.corp.example.com";
const CONFIG = parseCapdeltaConfig(`registry-hosts:\n  - ${HOST}\n`);

async function pack(
  entries: Record<string, string>,
): Promise<{ bytes: Buffer; integrity: string }> {
  const work = await mkdtemp(join(tmpdir(), "capdelta-registry-host-"));
  try {
    for (const [path, contents] of Object.entries(entries)) {
      const file = join(work, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");
    }
    const archive = join(work, "fixture.tgz");
    await tar.c(
      {
        cwd: work,
        file: archive,
        gzip: true,
        portable: true,
        mtime: new Date(0),
      },
      ["package"],
    );
    const bytes = await readFile(archive);
    return {
      bytes,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function lockfile(
  version: "1.0.0" | "2.0.0",
  integrity: string,
): Readonly<Record<string, unknown>> {
  return {
    name: "mirror-app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "mirror-app", version: "1.0.0" },
      "node_modules/mirror-fixture": {
        version,
        resolved: `https://${HOST}/mirror-fixture/-/mirror-fixture-${version}.tgz`,
        integrity,
      },
    },
  };
}

function serve(
  responses: ReadonlyMap<string, Uint8Array>,
  seen: string[],
): typeof fetch {
  return (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    seen.push(url);
    const bytes = responses.get(url);
    if (bytes === undefined) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  };
}

function packageJson(version: string): string {
  return `${JSON.stringify({ name: "mirror-fixture", version })}\n`;
}

describe("analyzeLockfiles with a configured registry host (ADR-0043)", () => {
  it("fetches the allowlisted host's tarball and verifies its SRI", async () => {
    const oldTarball = await pack({
      "package/package.json": packageJson("1.0.0"),
      "package/index.js": "module.exports = 1;\n",
    });
    const newTarball = await pack({
      "package/package.json": packageJson("2.0.0"),
      "package/index.js":
        'fetch("https://telemetry.example/collect").catch(() => {});\n',
    });
    const responses = new Map<string, Uint8Array>([
      [
        `https://${HOST}/mirror-fixture/-/mirror-fixture-1.0.0.tgz`,
        oldTarball.bytes,
      ],
      [
        `https://${HOST}/mirror-fixture/-/mirror-fixture-2.0.0.tgz`,
        newTarball.bytes,
      ],
    ]);
    const seen: string[] = [];

    const run = await analyzeLockfiles(
      lockfile("1.0.0", oldTarball.integrity),
      lockfile("2.0.0", newTarball.integrity),
      CONFIG,
      { fetcher: { fetchImpl: serve(responses, seen) } },
    );

    expect(run.summary).toEqual({
      changed: 1,
      analyzed: 1,
      unavailable: 0,
      skipped: 0,
    });
    expect(seen.sort()).toEqual([...responses.keys()].sort());
    const analyzed = run.packages[0];
    if (analyzed?.status !== "analyzed") {
      throw new Error("allowlisted package must be analyzed");
    }
    expect(
      analyzed.diff.findings.map((finding) => finding.capability.kind),
    ).toContain("NET");
  });

  it("fails a tampered tarball on an allowlisted host at the SRI check", async () => {
    const oldTarball = await pack({
      "package/package.json": packageJson("1.0.0"),
      "package/index.js": "module.exports = 1;\n",
    });
    const newTarball = await pack({
      "package/package.json": packageJson("2.0.0"),
      "package/index.js": "module.exports = 2;\n",
    });
    const tampered = await pack({
      "package/package.json": packageJson("2.0.0"),
      "package/index.js": 'require("node:child_process");\n',
    });
    const responses = new Map<string, Uint8Array>([
      [
        `https://${HOST}/mirror-fixture/-/mirror-fixture-1.0.0.tgz`,
        oldTarball.bytes,
      ],
      [
        `https://${HOST}/mirror-fixture/-/mirror-fixture-2.0.0.tgz`,
        tampered.bytes,
      ],
    ]);

    const run = await analyzeLockfiles(
      lockfile("1.0.0", oldTarball.integrity),
      lockfile("2.0.0", newTarball.integrity),
      CONFIG,
      { fetcher: { fetchImpl: serve(responses, []) } },
    );

    expect(run.summary).toEqual({
      changed: 1,
      analyzed: 0,
      unavailable: 1,
      skipped: 0,
    });
    const unavailable = run.packages[0];
    if (unavailable?.status !== "unavailable") {
      throw new Error("tampered package must stay unavailable");
    }
    expect(unavailable.failures[0]).toMatchObject({
      stage: "fetch",
      failure: { kind: "integrity-mismatch" },
    });
    expect(evaluateSeverityGate(buildRunReport(run), "CRITICAL")).toMatchObject(
      { fail: true },
    );
  });
});
