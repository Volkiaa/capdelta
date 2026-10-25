// DEFANGED RECONSTRUCTION of debug@4.4.1, the last benign version.
// Parsed by capdelta tests only. Nothing here is executed.
module.exports = function debug(namespace) {
  return function log(...values) {
    return [namespace, ...values];
  };
};
