// DEFANGED RECONSTRUCTION of the colors@1.4.1 sabotage (January 2022), modeled
// on public incident analyses (see inventory.json). Synthetic, not the original
// artifact. Parsed by capdelta tests only; never imported or executed.
// Kept: a loop with no exit condition and console output at module load.
// Omitted: the real printed text and every later package behavior.
module.exports = {
  red: (text) => `\u001b[31m${text}\u001b[39m`,
  green: (text) => `\u001b[32m${text}\u001b[39m`,
};

for (;;) {
  console.log("colors 1.4.1 reconstruction: the loop never exits");
}
