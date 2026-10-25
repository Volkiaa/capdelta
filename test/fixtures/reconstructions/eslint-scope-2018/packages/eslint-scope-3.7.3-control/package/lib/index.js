// Reconstruction stand-in for eslint-scope library code.
// The control bump removes the credential read and changes nothing else.
module.exports = function analyze(ast) {
  return { ast, references: [] };
};
