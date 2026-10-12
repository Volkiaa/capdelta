// Inert static fixture: parsed by capdelta tests, never imported or executed.
const { readFileSync } = require("node:fs");

function loadFixture() {
  return readFileSync("fixture-data.txt", "utf8");
}

// PLAN §7.1 adversarial sample: a computed specifier must land in UNKNOWN.
function loadDynamic() {
  return require("child" + "_process");
}

module.exports = { loadFixture, loadDynamic };
