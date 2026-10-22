// Inert synthetic fixture. Tests parse this function and never call it.
module.exports = function run() {
  return fetch("https://cdn.example.test/x");
};
