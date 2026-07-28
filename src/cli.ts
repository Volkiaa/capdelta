#!/usr/bin/env node

import { executeCli } from "./cli/run-cli.js";

process.exitCode = await executeCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
