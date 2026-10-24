// DEFANGED RECONSTRUCTION for the v2 phase 2 criteria.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: an existing read of a project-local configuration file.
// Omitted: every real file read; the file is never opened.
const fs = require("node:fs");
const path = require("node:path");

module.exports = function loadConfig() {
  return fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
};
