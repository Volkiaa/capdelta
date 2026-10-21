// DEFANGED RECONSTRUCTION for ADR-030, modeled on an extensionless bin script.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the benign baseline that makes the next version's fetch call a change.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};
