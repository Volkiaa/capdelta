import { describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "./manifest-analysis-pipeline.js";
import { renderSarifReport } from "./sarif-reporter.js";

describe("renderSarifReport", () => {
  it("renders SARIF 2.1.0 with inert attacker-controlled evidence", () => {
    const capability = {
      kind: "NET" as const,
      location: { kind: "runtime" as const },
      evidence: [
        {
          file: "lib/<script>.js",
          line: 3,
          snippet: "fetch('<img src=x onerror=alert(1)>')",
        },
      ] as const,
    };
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: {
            name: "bad](javascript:alert(1))",
            oldVersion: "1.0.0",
            newVersion: "2.0.0",
            oldIntegrity: "sha512-old",
            newIntegrity: "sha512-new",
            oldResolvedUrl: "https://registry.npmjs.org/old.tgz",
            resolvedUrl: "https://registry.npmjs.org/new.tgz",
          },
          diff: {
            baseline: {
              ecosystem: "npm",
              name: "bad](javascript:alert(1))",
              version: "1.0.0",
            },
            subject: {
              ecosystem: "npm",
              name: "bad](javascript:alert(1))",
              version: "2.0.0",
            },
            newPackage: false,
            findings: [
              { change: "added", severity: "HIGH", capability, previous: null },
            ],
            diagnostics: [],
          },
          issues: [],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const text = renderSarifReport(run);
    const sarif = JSON.parse(text) as {
      version: string;
      runs: [
        {
          results: {
            locations: {
              physicalLocation: { artifactLocation: { uri: string } };
            }[];
          }[];
        },
      ];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(
      sarif.runs[0].results[0]?.locations[0]?.physicalLocation.artifactLocation
        .uri,
    ).toContain("bad%5D(javascript%3Aalert(1))");
    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(text).not.toContain('"uri": "javascript:');
  });
});
