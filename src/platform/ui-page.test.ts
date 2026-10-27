import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  groupFlaggedReleases,
  isTestEvidencePath,
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

describe("isTestEvidencePath", () => {
  it("recognizes test directory segments and test basenames", () => {
    const testPaths = [
      "test/index.js",
      "tests/unit/index.js",
      "src/_test/index.js",
      "src/__tests__/index.js",
      "index.test.js",
      "src/index.spec.ts",
      "bench/index.bench.js",
      "fuzz/index.fuzz.ts",
      "src/latest.test.js",
    ];

    for (const file of testPaths) {
      expect(isTestEvidencePath(file), file).toBe(true);
    }
  });

  it("does not treat a name that only contains test as a test path", () => {
    expect(isTestEvidencePath("contest/x.js")).toBe(false);
    expect(isTestEvidencePath("latest.js")).toBe(false);
    expect(isTestEvidencePath("src/index.js")).toBe(false);
    expect(isTestEvidencePath("src/testing/index.js")).toBe(false);
    expect(isTestEvidencePath("test-utils/index.js")).toBe(false);
  });
});

describe("groupFlaggedReleases", () => {
  const counts = (severity: string, count: number): Record<string, number> => {
    const value = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    value[severity as keyof typeof value] = count;
    return value;
  };
  const finding = (
    name: string,
    version: string,
    severity: string,
    ruleKey: string,
    file: string,
  ) => ({
    name,
    version,
    severity,
    ruleKey,
    evidence: [{ file }],
  });

  it("flags only releases with critical or high and shows the worst severity", () => {
    const rows = groupFlaggedReleases(
      [
        { name: "alpha", version: "1.0.0", bySeverity: counts("CRITICAL", 1) },
        { name: "beta", version: "1.0.0", bySeverity: counts("HIGH", 2) },
        { name: "gamma", version: "1.0.0", bySeverity: counts("MEDIUM", 4) },
        { name: "delta", version: "1.0.0", bySeverity: counts("MEDIUM", 0) },
      ],
      [finding("delta", "1.0.0", "HIGH", "signal:wallet-swap", "index.js")],
    );

    expect(rows.map((row) => row.name)).toEqual(["alpha", "beta", "delta"]);
    expect(rows[0]?.severity).toBe("CRITICAL");
    expect(rows[1]?.severity).toBe("HIGH");
    expect(rows[1]?.findingCount).toBe(
      "CRITICAL 0, HIGH 2, MEDIUM 0, LOW 0, INFO 0",
    );
    expect(rows[2]?.findingCount).toBe("1");
  });

  it("does not lower the report severity when loaded findings are lighter", () => {
    const rows = groupFlaggedReleases(
      [{ name: "alpha", version: "1.0.0", bySeverity: counts("CRITICAL", 1) }],
      [finding("alpha", "1.0.0", "MEDIUM", "signal:wallet-swap", "index.js")],
    );

    expect(rows[0]?.severity).toBe("CRITICAL");
    expect(rows[0]?.findingCount).toBe("1");
  });

  it("puts a 0.0.0- version in the noise group without changing its severity", () => {
    const rows = groupFlaggedReleases(
      [
        {
          name: "ox",
          version: "0.0.0-alpha.2",
          bySeverity: counts("CRITICAL", 1),
        },
      ],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "ox",
      severity: "CRITICAL",
      noise: true,
    });
  });

  it("puts a release in the noise group when every critical or high finding sits on a test path", () => {
    const rows = groupFlaggedReleases(
      [{ name: "alpha", version: "1.0.0", bySeverity: counts("HIGH", 2) }],
      [
        finding("alpha", "1.0.0", "HIGH", "signal:wallet-swap", "test/a.js"),
        finding(
          "alpha",
          "1.0.0",
          "CRITICAL",
          "signal:wallet-swap",
          "src/__tests__/b.spec.ts",
        ),
      ],
    );

    expect(rows[0]?.noise).toBe(true);
    expect(rows[0]?.severity).toBe("CRITICAL");
    expect(rows[0]?.findingCount).toBe("2");
  });

  it("keeps a release flagged when one critical or high evidence file is not a test path", () => {
    const rows = groupFlaggedReleases(
      [{ name: "alpha", version: "1.0.0", bySeverity: counts("HIGH", 2) }],
      [
        finding("alpha", "1.0.0", "HIGH", "signal:wallet-swap", "test/a.js"),
        finding("alpha", "1.0.0", "HIGH", "signal:wallet-swap", "lib/index.js"),
      ],
    );

    expect(rows[0]?.noise).toBe(false);
  });

  it("does not call a release noise when no critical or high finding is loaded", () => {
    const rows = groupFlaggedReleases(
      [{ name: "alpha", version: "1.0.0", bySeverity: counts("HIGH", 1) }],
      [finding("alpha", "1.0.0", "MEDIUM", "signal:wallet-swap", "test/a.js")],
    );

    expect(rows[0]?.noise).toBe(false);
  });

  it("names the most common finding kind in the reason", () => {
    const rows = groupFlaggedReleases(
      [{ name: "alpha", version: "1.0.0", bySeverity: counts("HIGH", 3) }],
      [
        finding(
          "alpha",
          "1.0.0",
          "HIGH",
          "signal:wallet-address-swap",
          "index.js",
        ),
        finding(
          "alpha",
          "1.0.0",
          "HIGH",
          "signal:wallet-address-swap",
          "index.js",
        ),
        finding(
          "alpha",
          "1.0.0",
          "HIGH",
          "signal:new-external-endpoint",
          "index.js",
        ),
      ],
    );

    expect(rows[0]?.reason).toBe("wallet-address-swap x2");
  });
});

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

  it("renders flagged releases and a collapsed probably-noise group", () => {
    expect(STATUS_PAGE_HTML).toContain("Flagged releases");
    expect(STATUS_PAGE_HTML).toContain("<details");
    expect(STATUS_PAGE_HTML).toContain("Probably noise (0)");
    expect(STATUS_PAGE_HTML).toContain("display hint, not a verdict");
    expect(STATUS_PAGE_SCRIPT).toContain("0.0.0-");
    expect(STATUS_PAGE_SCRIPT).toContain("groupFlaggedReleases");
  });

  it("handles light and dark color schemes and phone widths", () => {
    expect(STATUS_PAGE_STYLE).toContain("prefers-color-scheme: dark");
    expect(STATUS_PAGE_STYLE).toContain("@media (max-width: 640px)");
    expect(STATUS_PAGE_HTML).toContain(
      'name="viewport" content="width=device-width, initial-scale=1"',
    );
  });
});
