import { describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import { ReporterContractError } from "./report-builder.js";
import { renderSarifReport } from "./sarif-reporter.js";

function changed(name: string, oldVersion: string | null): ChangedPackage {
  return {
    name,
    oldVersion,
    newVersion: "2.0.0",
    oldIntegrity: oldVersion === null ? null : "sha512-old",
    newIntegrity: "sha512-new",
    oldResolvedUrl:
      oldVersion === null ? null : "https://registry.npmjs.org/old.tgz",
    resolvedUrl: "https://registry.npmjs.org/new.tgz",
  };
}

function mismatchRun(
  packages: readonly { name: string; side: "old" | "new" }[],
): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: {
      changed: packages.length,
      analyzed: 0,
      unavailable: packages.length,
      skipped: 0,
    },
    packages: packages.map(({ name, side }) => ({
      status: "unavailable",
      changedPackage: changed(name, "1.0.0"),
      failures: [
        {
          stage: "fetch",
          failure: {
            side,
            kind: "integrity-mismatch",
            detail: "downloaded bytes do not match lockfile sha512 integrity",
            url: `https://registry.npmjs.org/${side}.tgz`,
          },
        },
      ],
    })),
    lockfileFindings: [],
    skipped: [],
  };
}

interface ParsedSarif {
  runs: [
    {
      tool: {
        driver: {
          rules: { id: string; shortDescription: { text: string } }[];
        };
      };
      results: {
        ruleId: string;
        level: string;
        message: Record<string, string>;
        locations: unknown[];
        properties: Record<string, unknown>;
      }[];
    },
  ];
}

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

  it("renders signal findings as SARIF results", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: {
            name: "fixture",
            oldVersion: "1.0.0",
            newVersion: "2.0.0",
            oldIntegrity: "sha512-old",
            newIntegrity: "sha512-new",
            oldResolvedUrl: "https://registry.npmjs.org/old.tgz",
            resolvedUrl: "https://registry.npmjs.org/new.tgz",
          },
          diff: {
            baseline: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
            subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
            newPackage: false,
            findings: [],
            signalFindings: [
              {
                kind: "entropy-jump",
                severity: "MEDIUM",
                change: "changed",
                detail: "loader.js entropy jumped",
                evidence: [{ file: "loader.js", line: 2, snippet: "payload" }],
              },
            ],
            diagnostics: [],
          },
          issues: [],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };

    const sarif = JSON.parse(renderSarifReport(run)) as {
      runs: [{ results: [{ ruleId: string; level: string }] }];
    };
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "CAPDELTA-SIGNAL-ENTROPY-JUMP",
      level: "warning",
    });
  });

  it("reports an unavailable package's integrity mismatch without a fabricated location", () => {
    const payload = "evil](javascript:alert(1))<img src=x onerror=alert(1)>";
    const text = renderSarifReport(
      mismatchRun([{ name: payload, side: "new" }]),
    );
    const sarif = JSON.parse(text) as ParsedSarif;

    expect(sarif.runs[0].results).toEqual([
      {
        ruleId: "CAPDELTA-INTEGRITY-MISMATCH",
        level: "error",
        message: {
          text: `Review this change: downloaded bytes do not match lockfile sha512 integrity for the new artifact of ${payload}@2.0.0; capdelta did not analyze it.`,
        },
        locations: [],
        properties: {
          kind: "analysis-issue",
          stage: "fetch",
          issue: "integrity-mismatch",
          side: "new",
          url: "https://registry.npmjs.org/new.tgz",
          severity: "CRITICAL",
          package: payload,
          version: "2.0.0",
          evidence: [],
        },
      },
    ]);
    expect(sarif.runs[0].tool.driver.rules).toEqual([
      expect.objectContaining({
        id: "CAPDELTA-INTEGRITY-MISMATCH",
        shortDescription: {
          text: "Downloaded artifact does not match lockfile integrity",
        },
      }),
    ]);
    // Attacker text stays plain JSON text: never markdown, never a link target.
    expect(text).not.toContain('"markdown"');
    expect(text).not.toContain('"uri"');
    expect(text).not.toMatch(/malware detected/iu);
  });

  it("attributes an old-side mismatch to the old version", () => {
    const sarif = JSON.parse(
      renderSarifReport(mismatchRun([{ name: "fixture", side: "old" }])),
    ) as ParsedSarif;
    expect(sarif.runs[0].results[0]?.properties).toMatchObject({
      side: "old",
      version: "1.0.0",
      url: "https://registry.npmjs.org/old.tgz",
    });
  });

  it("emits nothing for unavailable packages without a severity", () => {
    const run = mismatchRun([{ name: "missing", side: "new" }]);
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    const run404: CapabilityAnalysisRun = {
      ...run,
      packages: [
        {
          ...item,
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "http-status",
                detail: "HTTP 404",
                url: "https://registry.npmjs.org/new.tgz",
              },
            },
          ],
        },
      ],
    };
    const sarif = JSON.parse(renderSarifReport(run404)) as ParsedSarif;
    expect(sarif.runs[0].results).toEqual([]);
    expect(sarif.runs[0].tool.driver.rules).toEqual([]);
  });

  it("orders mismatch results deterministically", () => {
    const forward = renderSarifReport(
      mismatchRun([
        { name: "alpha", side: "new" },
        { name: "beta", side: "old" },
      ]),
    );
    const reversed = renderSarifReport(
      mismatchRun([
        { name: "beta", side: "old" },
        { name: "alpha", side: "new" },
      ]),
    );
    expect(reversed).toBe(forward);
  });

  it("rejects an old-side issue on a package with no old version", () => {
    const run = mismatchRun([{ name: "fresh", side: "old" }]);
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    const fresh: CapabilityAnalysisRun = {
      ...run,
      packages: [{ ...item, changedPackage: changed("fresh", null) }],
    };
    expect(() => renderSarifReport(fresh)).toThrow(ReporterContractError);
  });

  it.each([
    ["package-lock.json", "package-lock.json"],
    ["apps/web/package-lock.json", "apps/web/package-lock.json"],
    [
      "dir with space/ünï%#?.json",
      "dir%20with%20space/%C3%BCn%C3%AF%25%23%3F.json",
    ],
  ])(
    "points integrity results at the caller's lockfile %j without a region",
    (lockfilePath, uri) => {
      const sarif = JSON.parse(
        renderSarifReport(mismatchRun([{ name: "fixture", side: "new" }]), {
          lockfilePath,
        }),
      ) as ParsedSarif;
      expect(sarif.runs[0].results[0]?.locations).toEqual([
        { physicalLocation: { artifactLocation: { uri } } },
      ]);
    },
  );

  it("keeps an old-side message explicit when pointing at the lockfile", () => {
    const sarif = JSON.parse(
      renderSarifReport(mismatchRun([{ name: "fixture", side: "old" }]), {
        lockfilePath: "package-lock.json",
      }),
    ) as ParsedSarif;
    expect(sarif.runs[0].results[0]?.message.text).toContain(
      "for the old artifact of fixture@1.0.0",
    );
  });

  it.each([
    "",
    "/package-lock.json",
    "../package-lock.json",
    "./package-lock.json",
    "apps//package-lock.json",
    "apps/",
    "apps\\package-lock.json",
    "package-lock.json\0",
  ])("rejects lockfilePath %j even for an empty run", (lockfilePath) => {
    expect(() => renderSarifReport(mismatchRun([]), { lockfilePath })).toThrow(
      ReporterContractError,
    );
  });

  it("bounds oversized attacker-controlled identity, detail, and URL", () => {
    const run = mismatchRun([
      { name: `${"n".repeat(100_000)}\u001b[31m`, side: "new" },
    ]);
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    const longUrl = `https://registry.npmjs.org/${"u".repeat(100_000)}.tgz`;
    const oversized: CapabilityAnalysisRun = {
      ...run,
      packages: [
        {
          ...item,
          changedPackage: {
            ...item.changedPackage,
            newVersion: `2.0.0-${"v".repeat(100_000)}`,
          },
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "integrity-mismatch",
                detail: `mismatch ${"d".repeat(100_000)}\u0000`,
                url: longUrl,
              },
            },
          ],
        },
      ],
    };
    const text = renderSarifReport(oversized, {
      lockfilePath: "package-lock.json",
    });
    const result = (JSON.parse(text) as ParsedSarif).runs[0].results[0];
    if (result === undefined) throw new Error("missing result");

    expect(text.length).toBeLessThan(5_000);
    expect(String(result.properties.package)).toHaveLength(160);
    expect(String(result.properties.version)).toHaveLength(160);
    expect(String(result.properties.url)).toHaveLength(240);
    expect(String(result.properties.url).endsWith("\u2026")).toBe(true);
    expect(result.message.text?.length).toBeLessThan(700);
    expect(result).toMatchObject({
      level: "error",
      properties: { side: "new", severity: "CRITICAL" },
      locations: [
        {
          physicalLocation: { artifactLocation: { uri: "package-lock.json" } },
        },
      ],
    });
  });

  it("escapes control characters as JSON instead of emitting them raw", () => {
    const text = renderSarifReport(
      mismatchRun([{ name: "esc\u001b[31mred\u0007", side: "new" }]),
    );
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).toContain("esc\\u001b[31mred\\u0007");
  });

  it("reports a severity-bearing issue attached to an analyzed package", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: changed("fixture", "1.0.0"),
          diff: {
            baseline: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
            subject: { ecosystem: "npm", name: "fixture", version: "2.0.0" },
            newPackage: false,
            findings: [],
            diagnostics: [],
          },
          issues: [
            {
              stage: "fetch",
              failure: {
                side: "old",
                kind: "integrity-mismatch",
                detail:
                  "downloaded bytes do not match lockfile sha512 integrity",
                url: "https://registry.npmjs.org/old.tgz",
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const sarif = JSON.parse(renderSarifReport(run)) as ParsedSarif;
    expect(sarif.runs[0].results).toHaveLength(1);
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "CAPDELTA-INTEGRITY-MISMATCH",
      properties: { side: "old", version: "1.0.0" },
    });
  });
});
