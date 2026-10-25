// Reconstruction stand-in for eslint-scope library code.
module.exports = function analyze(ast) {
  return { ast, references: [] };
};
