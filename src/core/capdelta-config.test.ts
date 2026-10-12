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
    });
  });

  it("accepts an explicit empty allowlist", () => {
    expect(parseCapdeltaConfig("allowlist: []\n")).toEqual({ allowlist: [] });
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
