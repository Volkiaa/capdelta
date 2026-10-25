import { describe, expect, it } from "vitest";
import {
  CapdeltaConfigContractError,
  CapdeltaConfigParseError,
  applyCapabilityAllowlist,
  parseCapdeltaConfig,
} from "./capdelta-config.js";
import type { CapabilityDiffResult } from "./capability-differ.js";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import {
  buildRunReport,
  renderJsonReport,
  renderTextReport,
} from "./reporter.js";

const result: CapabilityDiffResult = {
  baseline: null,
  subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
  newPackage: true,
  findings: [
    {
      change: "added",
      severity: "HIGH",
      capability: {
        kind: "NET",
        location: { kind: "runtime" },
        evidence: [{ file: "index.js", line: 1, snippet: "fetch(url)" }],
      },
      previous: null,
    },
  ],
  signalFindings: [
    {
      kind: "new-external-endpoint",
      severity: "HIGH",
      change: "added",
      detail: "new external domain example.invalid",
      evidence: [{ file: "index.js", line: 1, snippet: "example.invalid" }],
    },
  ],
  diagnostics: [],
};

describe("capdelta config", () => {
  it("parses reviewed allowlist entries", () => {
    expect(
      parseCapdeltaConfig(
        `allowlist:\n  - package: fixture\n    capability: NET\n    justification: "documented telemetry endpoint"\n`,
      ),
    ).toEqual({
      allowlist: [
        {
          package: "fixture",
          capability: "NET",
          justification: "documented telemetry endpoint",
        },
      ],
      unanalyzable: [],
      registryHosts: ["registry.npmjs.org"],
    });
  });

  it("accepts an explicit empty allowlist", () => {
    expect(parseCapdeltaConfig("allowlist: []\n")).toEqual({
      allowlist: [],
      unanalyzable: [],
      registryHosts: ["registry.npmjs.org"],
    });
  });

  it("requires known capabilities and non-empty justifications", () => {
    expect(() =>
      parseCapdeltaConfig(
        "allowlist:\n  - package: fixture\n    capability: NET\n",
      ),
    ).toThrow(CapdeltaConfigContractError);
    expect(() =>
      parseCapdeltaConfig(
        "allowlist:\n  - package: fixture\n    capability: MALWARE\n    justification: no\n",
      ),
    ).toThrow(CapdeltaConfigContractError);
  });

  it("rejects ambiguous YAML instead of guessing", () => {
    expect(() =>
      parseCapdeltaConfig("allowlist:\n\t- package: fixture\n"),
    ).toThrow(CapdeltaConfigParseError);
    expect(() => parseCapdeltaConfig("other: value\n")).toThrow(
      CapdeltaConfigParseError,
    );
  });

  it("marks facts suppressed without deleting them", () => {
    const config = parseCapdeltaConfig(
      `allowlist:\n  - package: fixture\n    capability: NET\n    justification: "required by the public API"\n`,
    );
    const suppressed = applyCapabilityAllowlist(result, config);
    expect(suppressed.findings).toHaveLength(1);
    expect(suppressed.findings[0]?.suppression).toEqual({
      reason: "required by the public API",
    });
    expect(suppressed.signalFindings?.[0]?.suppression).toBeUndefined();
    expect(renderTextReport(suppressed)).toContain(
      'suppressed ("required by the public API")',
    );
    expect(JSON.parse(renderJsonReport(suppressed))).toMatchObject({
      findings: [{ suppression: { reason: "required by the public API" } }],
    });
  });

  describe("version-scoped entries", () => {
    const entry = (fields: string) =>
      `  - package: fixture\n    capability: NET\n    justification: "reviewed"\n${fields}`;
    const parse = (...entries: string[]) =>
      parseCapdeltaConfig(`allowlist:\n${entries.join("")}`);
    const at = (version: string): CapabilityDiffResult => ({
      ...result,
      subject: { ...result.subject, version },
    });

    it("suppresses only the exact reviewed version, with the scope leading the reason", () => {
      const config = parse(entry("    version: 2.0.0\n"));
      expect(config.allowlist[0]).toMatchObject({ version: "2.0.0" });
      expect(
        applyCapabilityAllowlist(at("2.0.0"), config).findings[0]?.suppression,
      ).toEqual({
        reason: "[version 2.0.0] reviewed",
      });
      for (const other of ["2.0.1", "1.9.9", "2.0.0-rc.1", "2.0.0+build.1"]) {
        expect(
          applyCapabilityAllowlist(at(other), config).findings[0]?.suppression,
        ).toBeUndefined();
      }
    });

    it("keeps prerelease and build metadata literally", () => {
      const config = parse(entry('    version: "2.0.0-rc.1+build.5"\n'));
      expect(config.allowlist[0]?.version).toBe("2.0.0-rc.1+build.5");
      expect(
        applyCapabilityAllowlist(at("2.0.0-rc.1+build.5"), config).findings[0]
          ?.suppression,
      ).toBeDefined();
      expect(
        applyCapabilityAllowlist(at("2.0.0-rc.1"), config).findings[0]
          ?.suppression,
      ).toBeUndefined();
    });

    it.each(["^2.0.0", "v2.0.0", "2.0", "latest", "02.0.0", '""'])(
      "rejects version %s with its line",
      (value) => {
        expect(() => parse(entry(`    version: ${value}\n`))).toThrow(
          /line 5/u,
        );
      },
    );

    it("allows several exact versions but rejects repeats and scoped/unscoped mixes", () => {
      expect(
        parse(entry("    version: 2.0.0\n"), entry("    version: 2.1.0\n"))
          .allowlist,
      ).toHaveLength(2);
      expect(() =>
        parse(entry("    version: 2.0.0\n"), entry("    version: 2.0.0\n")),
      ).toThrow(CapdeltaConfigContractError);
      for (const order of [
        [entry("    version: 2.0.0\n"), entry("")],
        [entry(""), entry("    version: 2.0.0\n")],
      ]) {
        expect(() => parse(...order)).toThrow(
          /mix version-scoped and unscoped/u,
        );
      }
    });

    it("keeps the scope visible when a long justification is truncated", () => {
      const config = parseCapdeltaConfig(
        `allowlist:\n  - package: fixture\n    capability: NET\n    version: 2.0.0\n    justification: "${"x".repeat(400)}"\n`,
      );
      const report = JSON.parse(
        renderJsonReport(applyCapabilityAllowlist(at("2.0.0"), config)),
      ) as {
        findings: { suppression?: { reason: string } }[];
      };
      const reason = report.findings[0]?.suppression?.reason ?? "";
      expect(reason.startsWith("[version 2.0.0] ")).toBe(true);
      expect(Array.from(reason)).toHaveLength(240);
    });

    it("stops suppressing a newly added native binary at any other version", () => {
      const native: CapabilityDiffResult = {
        baseline: null,
        subject: { ecosystem: "npm", name: "binding", version: "1.2.13" },
        newPackage: true,
        findings: [
          {
            change: "added",
            severity: "CRITICAL",
            capability: {
              kind: "NATIVE",
              location: { kind: "runtime" },
              evidence: [
                {
                  file: "binding.node",
                  line: 1,
                  snippet: "<native binary: binding.node>",
                },
              ],
            },
            previous: null,
          },
        ],
        diagnostics: [],
      };
      const config = parseCapdeltaConfig(
        'allowlist:\n  - package: binding\n    capability: NATIVE\n    version: 1.2.13\n    justification: "reviewed prebuilt binding"\n',
      );
      const gate = (version: string) => {
        const diff = applyCapabilityAllowlist(
          { ...native, subject: { ...native.subject, version } },
          config,
        );
        const run: CapabilityAnalysisRun = {
          firstRun: false,
          summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
          packages: [
            {
              status: "analyzed",
              changedPackage: {
                name: "binding",
                oldVersion: null,
                newVersion: version,
                oldIntegrity: null,
                newIntegrity: "sha512-new",
                oldResolvedUrl: null,
                resolvedUrl: "https://registry.npmjs.org/binding/-/binding.tgz",
              },
              diff,
              issues: [],
              baselineFailures: [],
            },
          ],
          lockfileFindings: [],
          skipped: [],
        };
        return buildRunReport(run).summary.gateSeverity.CRITICAL;
      };
      expect(gate("1.2.13")).toBe(0);
      expect(gate("1.2.14")).toBe(1);
    });
  });
});

const SRI_A =
  "sha512-BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw==";
const SRI_B =
  "sha512-CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ==";

describe("capdelta config unanalyzable exceptions (ADR-017)", () => {
  function entry(overrides: Record<string, string | null> = {}): string {
    const base: readonly [string, string][] = [
      ["package", "big-native-pkg"],
      ["version", "2.3.4"],
      ["integrity", SRI_A],
      ["kind", "expanded-size-limit"],
      ["justification", "reviewed upstream provenance"],
    ];
    const lines: string[] = [];
    for (const [key, fallback] of base) {
      const value = key in overrides ? overrides[key] : fallback;
      if (value === null || value === undefined) continue;
      lines.push(`${lines.length === 0 ? "  - " : "    "}${key}: ${value}`);
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null || base.some(([name]) => name === key)) continue;
      lines.push(`${lines.length === 0 ? "  - " : "    "}${key}: ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  function parseUnanalyzable(...entries: string[]) {
    return parseCapdeltaConfig(`unanalyzable:\n${entries.join("")}`);
  }

  const allowlistEntry =
    '  - package: fixture\n    capability: NET\n    justification: "reviewed"\n';

  it("parses both keys in either order", () => {
    const expected = {
      allowlist: [
        { package: "fixture", capability: "NET", justification: "reviewed" },
      ],
      unanalyzable: [
        {
          package: "big-native-pkg",
          version: "2.3.4",
          integrity: SRI_A,
          kind: "expanded-size-limit",
          justification: "reviewed upstream provenance",
        },
      ],
      registryHosts: ["registry.npmjs.org"],
    };
    expect(
      parseCapdeltaConfig(
        `allowlist:\n${allowlistEntry}unanalyzable:\n${entry()}`,
      ),
    ).toEqual(expected);
    expect(
      parseCapdeltaConfig(
        `unanalyzable:\n${entry()}allowlist:\n${allowlistEntry}`,
      ),
    ).toEqual(expected);
  });

  it("accepts an explicit empty unanalyzable list", () => {
    expect(parseCapdeltaConfig("unanalyzable: []\n")).toEqual({
      allowlist: [],
      unanalyzable: [],
      registryHosts: ["registry.npmjs.org"],
    });
    expect(parseCapdeltaConfig("allowlist: []\nunanalyzable: []\n")).toEqual({
      allowlist: [],
      unanalyzable: [],
      registryHosts: ["registry.npmjs.org"],
    });
  });

  it.each(["package", "version", "integrity", "kind", "justification"])(
    "rejects a missing %s",
    (field) => {
      expect(() => parseUnanalyzable(entry({ [field]: null }))).toThrow(
        CapdeltaConfigContractError,
      );
    },
  );

  it("rejects an unknown field", () => {
    expect(() => parseUnanalyzable(entry({ bogus: "x" }))).toThrow(
      CapdeltaConfigParseError,
    );
  });

  it.each(["1.2", "v2.3.4", "^2.3.4", "latest", "02.3.4"])(
    "rejects the non-exact semver %s",
    (version) => {
      expect(() => parseUnanalyzable(entry({ version }))).toThrow(
        CapdeltaConfigParseError,
      );
    },
  );

  it.each([
    "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "garbage",
    SRI_A.split("").reverse().join(""),
  ])("rejects the non-sha512 integrity %s", (integrity) => {
    expect(() => parseUnanalyzable(entry({ integrity }))).toThrow(
      CapdeltaConfigContractError,
    );
  });

  it("accepts multiple canonical sha512 tokens", () => {
    const config = parseUnanalyzable(entry({ integrity: `${SRI_A} ${SRI_B}` }));
    expect(config.unanalyzable[0]?.integrity).toBe(`${SRI_A} ${SRI_B}`);
  });

  it.each([
    "size-limit-exceeded",
    "invalid-url",
    "unsupported-integrity",
    "integrity-mismatch",
    // ADR-018
    "http-status",
    "invalid-response",
  ])("rejects the fetch-stage kind %s with its reason", (kind) => {
    expect(() => parseUnanalyzable(entry({ kind }))).toThrow(
      /fetch-stage failures occur before the artifact bytes are verified/u,
    );
  });

  it.each([
    "network-error",
    "timeout",
    "http-unavailable",
    "deadline-exceeded",
    "manifest-unreadable",
  ])("rejects the non-unanalyzable kind %s with its reason", (kind) => {
    expect(() => parseUnanalyzable(entry({ kind }))).toThrow(
      /not an unanalyzable failure/u,
    );
  });

  it.each([
    "expanded-size-limit",
    "link-entry",
    "manifest-missing",
    // ADR-019
    "manifest-not-regular",
  ])("accepts the post-verification kind %s", (kind) => {
    expect(parseUnanalyzable(entry({ kind })).unanalyzable[0]?.kind).toBe(kind);
  });

  it("rejects a duplicate tuple", () => {
    expect(() => parseUnanalyzable(entry(), entry())).toThrow(
      CapdeltaConfigContractError,
    );
  });

  it("does not treat integrities differing only by case as duplicates", () => {
    const caseFlipped = `sha512-${SRI_A.slice(7, 8).toLowerCase()}${SRI_A.slice(8)}`;
    expect(caseFlipped).not.toBe(SRI_A);
    expect(
      parseUnanalyzable(entry(), entry({ integrity: caseFlipped }))
        .unanalyzable,
    ).toHaveLength(2);
  });

  it("allows the same package and version with a different kind", () => {
    expect(
      parseUnanalyzable(entry(), entry({ kind: "link-entry" })).unanalyzable,
    ).toHaveLength(2);
  });

  it("rejects a duplicate top-level key", () => {
    expect(() => parseCapdeltaConfig("allowlist: []\nallowlist: []\n")).toThrow(
      CapdeltaConfigParseError,
    );
    expect(() =>
      parseCapdeltaConfig("unanalyzable: []\nunanalyzable: []\n"),
    ).toThrow(CapdeltaConfigParseError);
  });
});

describe("registry hosts (ADR-0043)", () => {
  const hosts = (...values: string[]) =>
    `registry-hosts:\n${values.map((value) => `  - ${value}\n`).join("")}`;

  it("defaults to registry.npmjs.org with no config", () => {
    expect(parseCapdeltaConfig("").registryHosts).toEqual([
      "registry.npmjs.org",
    ]);
    expect(parseCapdeltaConfig("registry-hosts: []\n").registryHosts).toEqual([
      "registry.npmjs.org",
    ]);
  });

  it("adds exact hosts, normalizes case, and keeps npmjs first", () => {
    const config = parseCapdeltaConfig(
      hosts("NPM.Corp.Example", "registry.npmjs.org", "mirror.example"),
    );
    expect(config.registryHosts).toEqual([
      "registry.npmjs.org",
      "npm.corp.example",
      "mirror.example",
    ]);
  });

  it("parses registry-hosts alongside the entry sections in either order", () => {
    const config = parseCapdeltaConfig(
      `registry-hosts:\n  - mirror.example\nallowlist:\n  - package: fixture\n    capability: NET\n    justification: "reviewed"\n`,
    );
    expect(config.registryHosts).toEqual([
      "registry.npmjs.org",
      "mirror.example",
    ]);
    expect(config.allowlist).toHaveLength(1);
  });

  it.each([
    "https://x",
    "x:443",
    "x:8443",
    "user@x",
    "x/path",
    "*.corp.example",
    "registry.npmjs.org.evil.com",
    "npmjs.org.registry.npmjs.org",
    "BÜCHER.example",
  ])("rejects the non-exact host %s", (value) => {
    expect(() => parseCapdeltaConfig(hosts(value))).toThrow(
      CapdeltaConfigParseError,
    );
  });

  it("rejects an empty entry and a non-list value", () => {
    expect(() => parseCapdeltaConfig("registry-hosts:\n  -\n")).toThrow(
      CapdeltaConfigParseError,
    );
    expect(() => parseCapdeltaConfig('registry-hosts:\n  - ""\n')).toThrow(
      CapdeltaConfigParseError,
    );
    expect(() =>
      parseCapdeltaConfig("registry-hosts: mirror.example\n"),
    ).toThrow(CapdeltaConfigParseError);
    expect(() =>
      parseCapdeltaConfig(
        "registry-hosts:\n  - mirror.example\n    port: 443\n",
      ),
    ).toThrow(CapdeltaConfigParseError);
  });

  it("rejects a duplicate host", () => {
    expect(() =>
      parseCapdeltaConfig(hosts("mirror.example", "MIRROR.example")),
    ).toThrow(CapdeltaConfigContractError);
  });

  it("rejects more than 32 hosts", () => {
    const many = Array.from(
      { length: 33 },
      (_, index) => `mirror-${String(index)}.example`,
    );
    expect(() => parseCapdeltaConfig(hosts(...many))).toThrow(
      CapdeltaConfigContractError,
    );
    expect(
      parseCapdeltaConfig(hosts(...many.slice(0, 32))).registryHosts,
    ).toHaveLength(33);
  });
});
