// DEFANGED RECONSTRUCTION of the Shai-Hulud 2.0 bun_environment.js payload (November 2025), modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: an encoded byte table and dynamic evaluation sink. Endor Labs describes the original
// as a 480,000+ line obfuscated payload; this decodes to an inert expression.
const t = [0x72, 0x65, 0x74, 0x75, 0x72, 0x6e, 0x20, 0x31];

function stage() {
  return new Function(String.fromCharCode(...t));
}

module.exports = { stage };
