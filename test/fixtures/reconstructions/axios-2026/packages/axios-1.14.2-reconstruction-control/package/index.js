// Benign control: library-only change, no new dependency or hook.
module.exports = function request(url) {
  return { url, retries: 0 };
};
