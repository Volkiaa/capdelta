#!/usr/bin/env node

import { runPlatformCli } from "./platform/platform-cli.js";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    controller.abort();
  });
}

process.exitCode = await runPlatformCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  signal: controller.signal,
});
