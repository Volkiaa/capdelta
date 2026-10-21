// DEFANGED RECONSTRUCTION for ADR-029, modeled on an underscore-label evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the benign baseline host that makes the next version's host a change.
// Omitted: every network call.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};
