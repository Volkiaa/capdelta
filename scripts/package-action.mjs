import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist", "action");
if (!output.startsWith(`${root}\\`) && !output.startsWith(`${root}/`)) {
  throw new Error("refusing to clean an Action bundle outside the repository");
}

await rm(output, { recursive: true, force: true });
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
    [cli, "build", "src/action.ts", "-o", "dist/action", "--minify"],
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
