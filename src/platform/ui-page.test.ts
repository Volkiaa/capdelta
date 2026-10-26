import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  STATUS_PAGE_CSP,
  STATUS_PAGE_HTML,
  STATUS_PAGE_SCRIPT,
  STATUS_PAGE_SCRIPT_HASH,
  STATUS_PAGE_STYLE,
  STATUS_PAGE_STYLE_HASH,
} from "./ui-page.js";

function hash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64");
}

describe("status page constants", () => {
  it("never uses an API that turns a string into markup", () => {
    const forbidden = [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval",
      "new Function",
      "href",
      "src",
    ];

    for (const name of forbidden) {
      expect(STATUS_PAGE_SCRIPT).not.toContain(name);
    }
    expect(STATUS_PAGE_HTML).not.toContain("<a ");
    expect(STATUS_PAGE_HTML).not.toContain("<img ");
  });

  it("builds cells with textContent and a non-URL data-label attribute", () => {
    expect(STATUS_PAGE_SCRIPT).toContain("node.textContent = text");
    expect(STATUS_PAGE_SCRIPT).toContain('setAttribute("data-label", label)');
  });

  it("computes the CSP hashes from the exact script and style bytes", () => {
    expect(STATUS_PAGE_SCRIPT_HASH).toBe(hash(STATUS_PAGE_SCRIPT));
    expect(STATUS_PAGE_STYLE_HASH).toBe(hash(STATUS_PAGE_STYLE));
    expect(STATUS_PAGE_CSP).toBe(
      `default-src 'none'; script-src 'sha256-${STATUS_PAGE_SCRIPT_HASH}'; style-src 'sha256-${STATUS_PAGE_STYLE_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
    );
    expect(STATUS_PAGE_HTML).toContain(`<style>${STATUS_PAGE_STYLE}</style>`);
    expect(STATUS_PAGE_HTML).toContain(
      `<script>${STATUS_PAGE_SCRIPT}</script>`,
    );
  });

  it("parses as plain JavaScript with no build step", () => {
    expect(() => new Script(STATUS_PAGE_SCRIPT)).not.toThrow();
  });

  it("refreshes every 15 seconds from the four read routes", () => {
    for (const path of [
      "/v1/jobs",
      "/v1/recent/releases",
      "/v1/recent/findings",
      "/v1/feed",
    ]) {
      expect(STATUS_PAGE_SCRIPT).toContain(path);
    }
    expect(STATUS_PAGE_SCRIPT).toContain("15000");
  });

  it("handles light and dark color schemes and phone widths", () => {
    expect(STATUS_PAGE_STYLE).toContain("prefers-color-scheme: dark");
    expect(STATUS_PAGE_STYLE).toContain("@media (max-width: 640px)");
    expect(STATUS_PAGE_HTML).toContain(
      'name="viewport" content="width=device-width, initial-scale=1"',
    );
  });
});
