// Reconstruction stand-in for event-stream library code.
module.exports = function through(input) {
  return { input, stream: true };
};
