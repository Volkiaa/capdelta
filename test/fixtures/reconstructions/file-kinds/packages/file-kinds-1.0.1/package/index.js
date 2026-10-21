// DEFANGED RECONSTRUCTION for ADR-030, modeled on an extensionless bin script.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the 1.0.0 fetch, so only the new bin script's host is a change.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};
