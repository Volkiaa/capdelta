// Synthetic mode-evasion fixture; parsed by tests, never executed. The
// postinstall hook reads an environment token and spawns a nonexistent
// fixture command; nothing is exfiltrated and nothing runs.
const cp = require("node:child_process");
module.exports = function install() {
  const token = process.env.NPM_TOKEN;
  return cp.spawnSync("capdelta-fixture-nonexistent-command", [String(token)]);
};
