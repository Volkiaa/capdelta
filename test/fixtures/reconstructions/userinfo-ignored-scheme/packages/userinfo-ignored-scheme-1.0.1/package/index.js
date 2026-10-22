// Inert synthetic fixture. Tests parse this function and never call it.
module.exports = function run() {
  return fetch("h\nttps://a.example.test b@evil.example.test/x");
};
