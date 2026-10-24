// DEFANGED RECONSTRUCTION for the v2 phase 2 criteria.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: an existing status request to a reserved .example.test host.
// Omitted: every real network call; the host is never contacted.
module.exports = function run() {
  return fetch("https://api.example.test/status");
};
