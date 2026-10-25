// Reconstruction stand-in for event-stream library code.
// The control bump drops the added dependency and changes nothing else.
module.exports = function through(input) {
  return { input, stream: true };
};
