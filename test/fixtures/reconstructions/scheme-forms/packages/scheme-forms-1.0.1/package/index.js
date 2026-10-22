// DEFANGED RECONSTRUCTION for ADR-029, modeled on scheme-form evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch whose scheme is upper-case and whose authority separator is a
// run of backslashes in the source (runtime value HTTPS:\\exfil.example.test/c).
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("HTTPS:\\\\exfil.example.test/c");
};
