// DEFANGED RECONSTRUCTION for ADR-029, modeled on the escaped-string evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the benign baseline connect to a private address the old side ignores.
// Omitted: every network call.
module.exports = function run() {
  return require("net").connect(443, "10.0.0.1");
};
