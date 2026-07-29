import type { BenignInstallScriptPattern } from "./contract/capability-set.js";

/**
 * Plan-seeded routine install commands. The FP corpus currently has no
 * targeted hook additions for these commands, so this recognizer is
 * deliberately conservative and remains provisional until M5 validation.
 */
export function recognizeBenignInstallScript(
  script: string,
): BenignInstallScriptPattern | null {
  const normalized = script.trim();
  if (normalized.length === 0 || /[|;&<>`$()\\\n\r]/u.test(normalized)) {
    return null;
  }
  const tokens = normalized.split(/\s+/u);
  const command = tokens[0];
  if (command === undefined) return null;

  const commandTokens = command === "npx" ? tokens.slice(1) : tokens;
  if (command === "npx" && commandTokens[0] === "--no-install") {
    commandTokens.shift();
  }
  if (
    commandTokens.length === 2 &&
    commandTokens[0] === "node-gyp" &&
    commandTokens[1] === "rebuild"
  ) {
    return "node-gyp-rebuild";
  }
  if (
    commandTokens.length === 2 &&
    commandTokens[0] === "husky" &&
    commandTokens[1] === "install"
  ) {
    return "husky-install";
  }
  if (commandTokens.length === 1 && commandTokens[0] === "patch-package") {
    return "patch-package";
  }
  return null;
}
