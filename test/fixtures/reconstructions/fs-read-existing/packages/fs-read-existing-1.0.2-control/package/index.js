// DEFANGED RECONSTRUCTION for the v2 phase 2 criteria, control side.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the existing project-local read and one added project-local read.
// Omitted: every real file read; the files are never opened.
const fs = require("node:fs");
const path = require("node:path");

module.exports = function loadConfig() {
  const config = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
  const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
  return { config, readme };
};
