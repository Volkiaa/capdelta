// DEFANGED RECONSTRUCTION for ADR-029, modeled on the escaped-string evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a connect whose address is hidden behind a hex escape in the source.
// Omitted: every network call; the address is a reserved documentation range.
module.exports = function run() {
  return require("net").connect(443, "93.184.216\x2e34");
};
