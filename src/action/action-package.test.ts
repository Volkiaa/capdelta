import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

describe("Action package", () => {
  it("targets Node 20 without placing workflow permissions in action metadata", async () => {
    const metadata = await readFile(resolve(ROOT, "action.yml"), "utf8");
    expect(metadata).toContain("using: node20");
    expect(metadata).toContain("main: dist/action/index.js");
    expect(metadata).not.toMatch(/^permissions:/mu);
    expect(metadata).not.toContain("security-events");
  });

  it("contains no pull_request_target workflow trigger", async () => {
    const workflowDirectory = resolve(ROOT, ".github", "workflows");
    const workflowNames = await readdir(workflowDirectory);
    const workflows = await Promise.all(
      workflowNames.map((name) =>
        readFile(resolve(workflowDirectory, name), "utf8"),
      ),
    );
    expect(workflows.join("\n")).not.toContain("pull_request_target");
  });

  it("executes the committed bundle and converts missing input into failure status", async () => {
    const result = await runBundle();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "::error::capdelta: Error: Input required and not supplied: github-token",
    );
    expect(result.stderr).toBe("");
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
