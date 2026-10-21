// DEFANGED RECONSTRUCTION for ADR-029, modeled on the inet_aton host evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a connect call to a documentation address as the quiet baseline.
// Omitted: every network call; the address is never contacted.
module.exports = function run() {
  return require("net").connect(443, "192.0.2.10");
};
