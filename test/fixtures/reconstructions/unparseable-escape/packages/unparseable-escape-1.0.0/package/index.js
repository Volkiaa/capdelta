// DEFANGED RECONSTRUCTION for the unparseable-escape incident.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch to the benign CDN baseline. The trailing marker is expanded to
// a block comment over the 2 MB parser limit when the tarball is packed, so the
// committed file stays small.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};

/* PAD */
