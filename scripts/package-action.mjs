import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist", "action");
if (!output.startsWith(`${root}\\`) && !output.startsWith(`${root}/`)) {
  throw new Error("refusing to clean an Action bundle outside the repository");
}

await rm(output, { recursive: true, force: true });
async function build(entry, destination) {
  await new Promise((resolveProcess, reject) => {
    const cli = resolve(
      root,
      "node_modules",
      "@vercel",
      "ncc",
      "dist",
      "ncc",
      "cli.js",
    );
    const child = spawn(
      process.execPath,
      [cli, "build", entry, "-o", destination, "--minify"],
      {
        cwd: root,
        windowsHide: true,
        shell: false,
        stdio: "inherit",
      },
    );
    child.once("error", (error) => {
      reject(new Error("cannot start ncc", { cause: error }));
    });
    child.once("close", (code) => {
      if (code === 0) resolveProcess();
      else reject(new Error(`ncc exited with status ${String(code)}`));
    });
  });
}

await build("src/action.ts", "dist/action");
await build(
  "src/core/npm/javascript-parser-worker.ts",
  "dist/action/parser-worker",
);
await rename(
  resolve(output, "parser-worker", "index.js"),
  resolve(output, "javascript-parser-worker.js"),
);
await rm(resolve(output, "parser-worker"), { recursive: true, force: false });
