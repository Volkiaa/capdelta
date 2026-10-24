#!/usr/bin/env node

import { runPlatformCli } from "./platform/platform-cli.js";

process.exitCode = await runPlatformCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
