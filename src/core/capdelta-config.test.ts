import { describe, expect, it } from "vitest";
import {
  CapdeltaConfigContractError,
  CapdeltaConfigParseError,
  applyCapabilityAllowlist,
  parseCapdeltaConfig,
} from "./capdelta-config.js";
import type { CapabilityDiffResult } from "./capability-differ.js";
import { renderJsonReport, renderTextReport } from "./reporter.js";

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
});
