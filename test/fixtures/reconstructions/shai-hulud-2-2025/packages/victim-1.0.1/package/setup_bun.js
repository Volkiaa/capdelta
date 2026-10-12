// DEFANGED RECONSTRUCTION of the Shai-Hulud 2.0 setup_bun.js loader (November 2025), modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: preinstall loader that would hand a payload file to another runtime.
// Omitted: runtime download/installation and any execution.
const { spawnSync } = require("node:child_process");

function load() {
  return spawnSync("capdelta-fixture-nonexistent-runtime", ["bun_environment.js"]);
}

module.exports = { load };
