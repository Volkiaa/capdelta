// DEFANGED RECONSTRUCTION for the v2 phase 2 criteria.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the existing project-local read and two added reads of credential files
// under the home directory.
// Omitted: every real file read; no file is opened and no credential is used.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = function loadConfig() {
  const config = fs.readFileSync(path.join(__dirname, "config.json"), "utf8");
  const npmrc = fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf8");
  const key = fs.readFileSync(path.join(os.homedir(), ".ssh/id_rsa"), "utf8");
  return { config, npmrc, key };
};
