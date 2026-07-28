import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

describe("Action package", () => {
  it("targets Node 20 without placing workflow permissions in action metadata", async () => {
    const metadata = await readFile(resolve(ROOT, "action.yml"), "utf8");
    expect(metadata).toContain("using: node20");
    expect(metadata).toContain("main: dist/action/index.js");
    expect(metadata).not.toMatch(/^permissions:/mu);
    expect(metadata).not.toContain("permissions:");
  });

  it("contains no pull_request_target workflow trigger", async () => {
    const workflowDirectory = resolve(ROOT, ".github", "workflows");
    const workflowNames = await readdir(workflowDirectory);
    const workflows = await Promise.all(
      workflowNames.map((name) =>
        readFile(resolve(workflowDirectory, name), "utf8"),
      ),
    );
    expect(workflows.join("\n")).not.toMatch(/^\s*pull_request_target\s*:/mu);
  });

  it("dogfoods with only the approved workflow permissions and trusted code", async () => {
    const workflow = await readFile(
      resolve(ROOT, ".github", "workflows", "capdelta.yml"),
      "utf8",
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("security-events: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "Volkiaa/capdelta@89f87e0007b128496c5818005c884c1ac2f3ea74",
    );
    expect(workflow).not.toContain("uses: ./");
    await expect(
      access(resolve(ROOT, "dist", "action", "javascript-parser-worker.js")),
    ).resolves.toBeUndefined();
  });

  it("executes the committed bundle and converts missing input into failure status", async () => {
    const result = await runBundle();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "::error::capdelta: Error: Input required and not supplied: github-token",
    );
    expect(result.stderr).toBe("");
  });

  it("executes the separately packaged parser worker", async () => {
    const worker = new Worker(
      resolve(ROOT, "dist", "action", "javascript-parser-worker.js"),
    );
    const responses = await new Promise<unknown[]>(
      (resolveResponse, reject) => {
        const received: unknown[] = [];
        worker.on("message", (response) => {
          received.push(response);
          if (received.length === 1) {
            worker.postMessage({
              source: "process.env.TEST;",
              file: "second.js",
              sourceType: "script",
            });
          } else {
            resolveResponse(received);
          }
        });
        worker.once("error", reject);
        worker.postMessage({
          source: "fetch('https://example.test');",
          file: "fixture.js",
          sourceType: "script",
        });
      },
    );
    await worker.terminate();
    expect(responses[0]).toMatchObject({
      ok: true,
      detections: [{ kind: "NET", line: 1 }],
    });
    expect(responses[1]).toMatchObject({
      ok: true,
      detections: [{ kind: "ENV", line: 1 }],
    });
  });
});

async function runBundle(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(ROOT, "dist", "action", "index.js")],
      {
        cwd: ROOT,
        env: { ...process.env, "INPUT_GITHUB-TOKEN": "" },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(
        new Error("cannot start committed Action bundle", { cause: error }),
      );
    });
    child.once("close", (code) => {
      resolveResult({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
