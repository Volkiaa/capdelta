// Inert static fixture: parsed by capdelta tests, never imported or executed.
import { spawnSync } from "node:child_process";

const table = [0x63, 0x61, 0x70, 0x64, 0x65, 0x6c, 0x74, 0x61];

export function run() {
  return spawnSync("capdelta-fixture-nonexistent-command", [String.fromCharCode(...table)]);
}
