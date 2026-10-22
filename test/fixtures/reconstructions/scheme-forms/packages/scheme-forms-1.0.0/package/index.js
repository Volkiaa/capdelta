// DEFANGED RECONSTRUCTION for ADR-029, modeled on scheme-form evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the benign baseline fetch that makes the next version a destination swap.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};
