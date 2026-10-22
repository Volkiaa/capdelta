// DEFANGED RECONSTRUCTION for the userinfo-space evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the benign baseline whose only network call reaches a CDN host.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};
