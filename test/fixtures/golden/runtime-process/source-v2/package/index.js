// Inert static fixture: parsed by capdelta tests, never imported or executed.
import { spawnSync } from "node:child_process";

export function run() {
  return spawnSync("capdelta-fixture-nonexistent-command", ["--version"]);
}
