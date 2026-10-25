// Reconstruction stand-in for ua-parser-js library code.
// The control bump removes the preinstall hook and changes nothing else.
module.exports = function parseUserAgent(value) {
  return { ua: value };
};
