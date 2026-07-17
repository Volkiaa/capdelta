import { describe, expect, it } from "vitest";
import type { CapabilityDiffResult } from "./capability-differ.js";
import {
  ReporterContractError,
  renderJsonReport,
  renderTextReport,
} from "./reporter.js";

function emptyResult(): CapabilityDiffResult {
  return {
    baseline: {
      ecosystem: "npm",
      name: "fixture",
      version: "1.0.0",
    },
    subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
    newPackage: false,
    findings: [],
    diagnostics: [],
  };
}

describe("manifest Reporter", () => {
  it("renders escaped and bounded attacker-controlled strings in JSON and text", () => {
    const attacker = 'evil"\n<script>[x](javascript:alert(1))';
    const result: CapabilityDiffResult = {
      baseline: null,
      subject: { ecosystem: "npm", name: attacker, version: "2.0.0" },
      newPackage: true,
      findings: [
        {
          severity: "LOW",
          change: "added",
          capability: {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: attacker,
            requirement: `^1.0.0${"x".repeat(300)}`,
            evidence: [
              {
                file: attacker,
                line: 4,
                snippet: `${attacker}${"y".repeat(300)}`,
              },
            ],
          },
          previous: null,
        },
      ],
      diagnostics: [],
    };

    const json = renderJsonReport(result);
    const text = renderTextReport(result);

    expect(json).toContain('evil\\"\\n<script>');
    expect(text).toContain('evil\\"\\n<script>');
    expect(text).not.toContain('evil"\n<script>');
    const parsed = JSON.parse(json) as {
      findings: {
        capability: {
          requirement: string;
          evidence: { snippet: string }[];
        };
      }[];
    };
    expect(
      Array.from(parsed.findings[0]?.capability.requirement ?? ""),
    ).toHaveLength(240);
    expect(
      Array.from(parsed.findings[0]?.capability.evidence[0]?.snippet ?? ""),
    ).toHaveLength(240);
  });

  it("renders a stable no-findings report", () => {
    expect(renderTextReport(emptyResult())).toBe(
      [
        "capdelta manifest capability report",
        'Package: "fixture" ("npm") "1.0.0" -> "2.0.0"',
        "Review this change: no manifest capability additions; 0 diagnostics.",
        "",
      ].join("\n"),
    );
  });

  it("throws for inconsistent findings and unsupported future capabilities", () => {
    const inconsistent: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "LOW",
          change: "added",
          capability: {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: "dep",
            requirement: "1",
            evidence: [
              { file: "package.json", line: 1, snippet: '"dep": "1"' },
            ],
          },
          previous: {
            kind: "DEPENDENCY",
            location: { kind: "manifest" },
            name: "dep",
            requirement: "0",
            evidence: [
              { file: "package.json", line: 1, snippet: '"dep": "0"' },
            ],
          },
        },
      ],
    };
    expect(() => renderJsonReport(inconsistent)).toThrow(ReporterContractError);

    const future: CapabilityDiffResult = {
      ...emptyResult(),
      findings: [
        {
          severity: "HIGH",
          change: "added",
          capability: {
            kind: "NET",
            location: { kind: "runtime" },
            evidence: [
              { file: "index.js", line: 1, snippet: 'fetch("example")' },
            ],
          },
          previous: null,
        },
      ],
    };
    expect(() => renderTextReport(future)).toThrow(ReporterContractError);
  });
});
