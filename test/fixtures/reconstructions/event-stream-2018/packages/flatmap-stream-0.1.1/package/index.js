// DEFANGED RECONSTRUCTION of the event-stream backdoor (November 2018), modeled on public incident analyses
// (see test/fixtures/reconstructions/inventory.json). Synthetic, not the original artifact.
// Parsed by capdelta tests only; never imported, installed, or executed.
// Kept: the encrypted blob, the key derived from the event-stream description,
// and the eval sink the decrypted text is handed to.
// Omitted: the real ciphertext, the real key, the wallet-stealing payload, and every call.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Inert placeholder. The original held AES ciphertext; this decodes to nothing usable.
const blob = "Y2FwZGVsdGEtaW5lcnQtcmVjb25zdHJ1Y3Rpb24=";

function derivedKey() {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "event-stream", "package.json"),
      "utf8",
    ),
  );
  return crypto.createHash("sha256").update(manifest.description).digest();
}

function unpack() {
  const decipher = crypto.createDecipheriv(
    "aes-256-ctr",
    derivedKey(),
    Buffer.alloc(16),
  );
  const code = Buffer.concat([
    decipher.update(Buffer.from(blob, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return eval(code);
}

module.exports = { unpack };
