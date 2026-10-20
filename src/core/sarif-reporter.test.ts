import { describe, expect, it } from "vitest";
import type { CapabilityAnalysisRun } from "./capability-analysis-pipeline.js";
import type {
  ChangedPackage,
  LockfileFinding,
} from "./contract/lockfile-diff.js";
import { ReporterContractError } from "./report-builder.js";
import { renderSarifReport } from "./sarif-reporter.js";
import {
  applyCapabilityAllowlist,
  parseCapdeltaConfig,
} from "./capdelta-config.js";
import {
  diffCapabilities,
  type CapabilityDiffResult,
} from "./capability-differ.js";
import { buildRunReport } from "./report-builder.js";
import { buildSignalSet, observeSignalSource } from "./signal-extractor.js";
import type { Capability, CapabilitySet } from "./contract/capability-set.js";

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

function lockfileRun(
  lockfileFindings: readonly LockfileFinding[],
): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 0, analyzed: 0, unavailable: 0, skipped: 0 },
    packages: [],
    lockfileFindings: [...lockfileFindings],
    skipped: [],
  };
}

interface ParsedSarif {
  runs: [
    {
      tool: {
        driver: {
          rules: {
            id: string;
            shortDescription: { text: string };
            help: { text: string };
          }[];
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

  it("emits nothing for a transient failure but a rule for a non-retryable status (ADR-018)", () => {
    const run = mismatchRun([{ name: "missing", side: "new" }]);
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    const transient: CapabilityAnalysisRun = {
      ...run,
      packages: [
        {
          ...item,
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "network-error",
                detail: "connection reset",
                url: "https://registry.npmjs.org/new.tgz",
              },
            },
          ],
        },
      ],
    };
    const transientSarif = JSON.parse(
      renderSarifReport(transient),
    ) as ParsedSarif;
    expect(transientSarif.runs[0].results).toEqual([]);
    expect(transientSarif.runs[0].tool.driver.rules).toEqual([]);

    const notFound: CapabilityAnalysisRun = {
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
    const notFoundSarif = JSON.parse(
      renderSarifReport(notFound),
    ) as ParsedSarif;
    expect(notFoundSarif.runs[0].results).toEqual([
      expect.objectContaining({
        ruleId: "CAPDELTA-HTTP-STATUS",
        level: "error",
      }),
    ]);
    expect(notFoundSarif.runs[0].tool.driver.rules).toEqual([
      expect.objectContaining({
        id: "CAPDELTA-HTTP-STATUS",
        shortDescription: { text: "Package could not be analyzed" },
      }),
    ]);
  });

  it("describes an unanalyzable package without asserting malware", () => {
    const run = mismatchRun([{ name: "oversized", side: "new" }]);
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    const overCap: CapabilityAnalysisRun = {
      ...run,
      packages: [
        {
          ...item,
          failures: [
            {
              stage: "new-extraction",
              failure: {
                kind: "expanded-size-limit",
                detail: "expanded size over the extraction cap",
              },
            },
          ],
        },
      ],
    };

    const text = renderSarifReport(overCap);
    const sarif = JSON.parse(text) as ParsedSarif;
    expect(sarif.runs[0].results).toEqual([
      expect.objectContaining({
        ruleId: "CAPDELTA-EXPANDED-SIZE-LIMIT",
        level: "error",
      }),
    ]);
    expect(sarif.runs[0].tool.driver.rules).toEqual([
      expect.objectContaining({
        id: "CAPDELTA-EXPANDED-SIZE-LIMIT",
        shortDescription: { text: "Package could not be analyzed" },
      }),
    ]);
    expect(text).toContain(
      "capdelta could not inspect this artifact, so anything in it is unreviewed.",
    );
    expect(text).toContain("This result does not assert malware.");
    expect(text).not.toMatch(/malware detected/iu);
  });

  it("gives install-hook, install-time execution, integrity, and unanalyzable rules distinct help", () => {
    const installScriptLocation = {
      kind: "install-script" as const,
      hook: "postinstall" as const,
      applicability: "registry-install" as const,
    };
    const installScriptNet: Capability = {
      kind: "NET",
      location: installScriptLocation,
      evidence: [{ file: "install.js", line: 1, snippet: 'require("https")' }],
    };
    const installHook: Capability = {
      kind: "INSTALL_HOOK",
      location: installScriptLocation,
      contentDigest: { algorithm: "sha256", value: "a".repeat(64) },
      evidence: [{ file: "package.json", line: 1, snippet: '"postinstall"' }],
    };
    const analyzed: CapabilityAnalysisRun["packages"][number] = {
      status: "analyzed",
      changedPackage: changed("hooked", "1.0.0"),
      diff: {
        baseline: { ecosystem: "npm", name: "hooked", version: "1.0.0" },
        subject: { ecosystem: "npm", name: "hooked", version: "2.0.0" },
        newPackage: false,
        findings: [
          {
            change: "added",
            severity: "CRITICAL",
            capability: installScriptNet,
            previous: null,
          },
          {
            change: "added",
            severity: "CRITICAL",
            capability: installHook,
            previous: null,
          },
        ],
        shapes: [
          {
            ruleId: "install-code-execution",
            severity: "CRITICAL",
            capabilities: [installScriptNet],
          },
          {
            ruleId: "install-hook-change",
            severity: "CRITICAL",
            capabilities: [installHook],
          },
        ],
        diagnostics: [],
      },
      issues: [],
    };
    const integrityPackage: CapabilityAnalysisRun["packages"][number] = {
      status: "unavailable",
      changedPackage: changed("tampered", "1.0.0"),
      failures: [
        {
          stage: "fetch",
          failure: {
            side: "new",
            kind: "integrity-mismatch",
            detail: "downloaded bytes do not match lockfile sha512 integrity",
            url: "https://registry.npmjs.org/new.tgz",
          },
        },
      ],
    };
    const unanalyzablePackage: CapabilityAnalysisRun["packages"][number] = {
      status: "unavailable",
      changedPackage: changed("oversized", "1.0.0"),
      failures: [
        {
          stage: "new-extraction",
          failure: {
            kind: "expanded-size-limit",
            detail: "expanded size over the extraction cap",
          },
        },
      ],
    };
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 3, analyzed: 1, unavailable: 2, skipped: 0 },
      packages: [analyzed, integrityPackage, unanalyzablePackage],
      lockfileFindings: [],
      skipped: [],
    };
    const rules = (JSON.parse(renderSarifReport(run)) as ParsedSarif).runs[0]
      .tool.driver.rules;
    const helpOf = (id: string): string => {
      const rule = rules.find((item) => item.id === id);
      if (rule === undefined) throw new Error(`missing rule ${id}`);
      return rule.help.text;
    };
    const hooks = helpOf("CAPDELTA-SHAPE-INSTALL-HOOK-CHANGE");
    const execution = helpOf("CAPDELTA-SHAPE-INSTALL-CODE-EXECUTION");
    const integrityHelp = helpOf("CAPDELTA-INTEGRITY-MISMATCH");
    const unanalyzableHelp = helpOf("CAPDELTA-EXPANDED-SIZE-LIMIT");
    expect(
      new Set([hooks, execution, integrityHelp, unanalyzableHelp]).size,
    ).toBe(4);
    for (const text of [hooks, execution, integrityHelp, unanalyzableHelp]) {
      expect(text).toContain("This result does not assert malware.");
    }
  });

  it("marks an excepted package's failures with a reviewed suppression (ADR-017)", () => {
    const run = mismatchRun([{ name: "oversized", side: "new" }]);
    const item = run.packages[0];
    if (item?.status !== "unavailable") throw new Error("fixture drift");
    const excepted: CapabilityAnalysisRun = {
      ...run,
      packages: [
        {
          ...item,
          exception: { reason: "[version 2.0.0] reviewed oversized fixture" },
          failures: [
            {
              stage: "new-extraction",
              failure: {
                kind: "expanded-size-limit",
                detail: "expanded size over the extraction cap",
              },
            },
          ],
        },
      ],
    };
    const sarif = JSON.parse(renderSarifReport(excepted)) as ParsedSarif;
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: "CAPDELTA-EXPANDED-SIZE-LIMIT",
      level: "error",
      properties: {
        suppression: "[version 2.0.0] reviewed oversized fixture",
      },
    });
    expect(sarif.runs[0].results[0]?.message.text).toContain(
      "Suppressed ([version 2.0.0] reviewed oversized fixture)",
    );
  });

  it("renders an old-side manifest-not-regular failure as an unanalyzable error (ADR-019)", () => {
    const run: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: changed("nonregular", "1.0.0"),
          failures: [
            {
              stage: "old-manifest",
              failure: {
                kind: "manifest-not-regular",
                detail: "package.json is not a regular file",
                evidence: null,
              },
            },
          ],
          // ADR-017
          exception: {
            reason: "[version 1.0.0] reviewed non-regular manifest",
          },
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const sarif = JSON.parse(renderSarifReport(run)) as ParsedSarif;
    const result = sarif.runs[0].results[0];
    expect(result).toMatchObject({
      ruleId: "CAPDELTA-MANIFEST-NOT-REGULAR",
      level: "error",
      properties: {
        version: "1.0.0",
        side: "old",
        suppression: "[version 1.0.0] reviewed non-regular manifest",
      },
    });
    expect(result?.message.text).toContain(
      "for the old artifact of nonregular@1.0.0",
    );
    const rule = sarif.runs[0].tool.driver.rules.find(
      (item) => item.id === "CAPDELTA-MANIFEST-NOT-REGULAR",
    );
    expect(rule?.help.text).toContain(
      "capdelta could not inspect this artifact, so anything in it is unreviewed.",
    );
    expect(rule?.help.text).toContain(
      "Inspect the artifact manually, or add a reviewed exception bound to these bytes (ADR-017).",
    );
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

  describe("lockfile findings", () => {
    it("renders a same-version integrity change as an error at the lockfile", () => {
      const sarif = JSON.parse(
        renderSarifReport(
          lockfileRun([
            {
              kind: "integrity-changed-version-same",
              name: "golden-integrity",
              path: "node_modules/golden-integrity",
              oldVersion: "1.0.0",
              newVersion: "1.0.0",
            },
          ]),
          { lockfilePath: "package-lock.json" },
        ),
      ) as ParsedSarif;

      expect(sarif.runs[0].tool.driver.rules).toEqual([
        expect.objectContaining({
          id: "CAPDELTA-LOCKFILE-INTEGRITY-CHANGED-VERSION-SAME",
          shortDescription: { text: "Lockfile entry changed" },
        }),
      ]);
      expect(sarif.runs[0].tool.driver.rules[0]?.help.text).toContain(
        "npm does not let a published version change its contents, so different bytes under the same version mean the lockfile entry, its resolved URL, or the registry changed.",
      );
      expect(sarif.runs[0].tool.driver.rules[0]?.help.text).toContain(
        "Compare the old and new resolved and integrity fields, find the commit that changed them, and regenerate the lockfile from a trusted registry if nobody can explain the change.",
      );
      expect(sarif.runs[0].tool.driver.rules[0]?.help.text).toContain(
        "This result does not assert malware.",
      );
      expect(sarif.runs[0].results).toEqual([
        {
          ruleId: "CAPDELTA-LOCKFILE-INTEGRITY-CHANGED-VERSION-SAME",
          level: "error",
          message: {
            text: "Review this change: integrity-changed-version-same for golden-integrity at node_modules/golden-integrity: 1.0.0 -> 1.0.0.",
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "package-lock.json" },
              },
            },
          ],
          properties: {
            kind: "lockfile",
            lockfileFinding: "integrity-changed-version-same",
            path: "node_modules/golden-integrity",
            oldVersion: "1.0.0",
            newVersion: "1.0.0",
            severity: "HIGH",
            package: "golden-integrity",
            version: "1.0.0",
            evidence: [],
          },
        },
      ]);
    });

    it("renders a version downgrade as a note", () => {
      const sarif = JSON.parse(
        renderSarifReport(
          lockfileRun([
            {
              kind: "version-downgrade",
              name: "left-pad",
              path: "node_modules/left-pad",
              oldVersion: "2.0.0",
              newVersion: "1.0.0",
            },
          ]),
        ),
      ) as ParsedSarif;

      expect(sarif.runs[0].results).toEqual([
        expect.objectContaining({
          ruleId: "CAPDELTA-LOCKFILE-VERSION-DOWNGRADE",
          level: "note",
          properties: expect.objectContaining({ severity: "INFO" }) as unknown,
        }),
      ]);
    });

    it("bounds attacker-controlled lockfile identity and path", () => {
      const marker = "](http://x)";
      const sarifText = renderSarifReport(
        lockfileRun([
          {
            kind: "integrity-changed-version-same",
            name: `%evil${"n".repeat(300)}${marker}`,
            path: `%node_modules/${"p".repeat(300)}${marker}`,
            oldVersion: `%1.0.0-${"o".repeat(300)}${marker}`,
            newVersion: `%2.0.0-${"v".repeat(300)}${marker}`,
          },
        ]),
        { lockfilePath: "lock dir%/package-lock.json" },
      );
      const result = (JSON.parse(sarifText) as ParsedSarif).runs[0].results[0];
      if (result === undefined) throw new Error("missing result");

      expect(Array.from(String(result.properties.package))).toHaveLength(160);
      expect(Array.from(String(result.properties.path))).toHaveLength(200);
      expect(Array.from(String(result.properties.oldVersion))).toHaveLength(
        160,
      );
      expect(Array.from(String(result.properties.newVersion))).toHaveLength(
        160,
      );
      expect(String(result.properties.package).endsWith("\u2026")).toBe(true);
      expect(String(result.properties.path).endsWith("\u2026")).toBe(true);
      expect(result.message.text).not.toContain(marker);
      expect(result.message.text).toContain("%evil");
      expect(result.message.text).toContain("%node_modules/");
      expect(result.message.text).not.toContain("http://x");
      expect(sarifText).not.toContain("http://x");
      expect(result.locations).toEqual([
        {
          physicalLocation: {
            artifactLocation: { uri: "lock%20dir%25/package-lock.json" },
          },
        },
      ]);
    });

    it("omits the location when the caller gives no lockfile path", () => {
      const sarif = JSON.parse(
        renderSarifReport(
          lockfileRun([
            {
              kind: "integrity-changed-version-same",
              name: "golden-integrity",
              path: "node_modules/golden-integrity",
              oldVersion: "1.0.0",
              newVersion: "1.0.0",
            },
          ]),
        ),
      ) as ParsedSarif;

      expect(sarif.runs[0].results[0]?.locations).toEqual([]);
    });
  });

  describe("shape suppression visibility", () => {
    const capability = (
      kind: "NATIVE" | "DYNAMIC_CODE" | "NET" | "ENV" | "PROCESS",
      file: string,
      snippet: string,
    ): Capability => ({
      kind,
      location: { kind: "runtime" },
      evidence: [{ file, line: 1, snippet }],
    });
    const native = capability(
      "NATIVE",
      "binding.node",
      "<native binary: binding.node>",
    );
    const dynamic = capability(
      "DYNAMIC_CODE",
      "index.js",
      "new Function(code)",
    );
    const net = capability("NET", "net.js", "fetch(url)");
    const env = capability("ENV", "env.js", "process.env.TOKEN");
    const process = capability("PROCESS", "index.js", "spawnSync(cmd)");
    const set = (
      version: string,
      capabilities: readonly Capability[],
    ): CapabilitySet => ({
      schemaVersion: 1,
      subject: { ecosystem: "npm", name: "binding", version },
      completeness: "complete",
      capabilities,
      diagnostics: [],
    });
    const runFor = (diff: CapabilityDiffResult): CapabilityAnalysisRun => ({
      firstRun: false,
      summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
      packages: [
        {
          status: "analyzed",
          changedPackage: {
            ...changed("binding", "1.0.0"),
            newVersion: "1.2.13",
          },
          diff,
          issues: [],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    });
    const analyze = (newSet: CapabilitySet, config: string) => {
      const run = runFor(
        applyCapabilityAllowlist(
          diffCapabilities(set("1.0.0", []), newSet),
          parseCapdeltaConfig(config),
        ),
      );
      return {
        results: (JSON.parse(renderSarifReport(run)) as ParsedSarif).runs[0]
          .results,
        gate: buildRunReport(run).summary.gateSeverity,
      };
    };
    const entry = (kind: string, reason: string) =>
      `  - package: binding\n    capability: ${kind}\n    version: 1.2.13\n    justification: "${reason}"\n`;
    const config = (...entries: string[]) =>
      entries.length === 0
        ? "allowlist: []\n"
        : `allowlist:\n${entries.join("")}`;
    const statusOf = (
      result: ParsedSarif["runs"][0]["results"][number] | undefined,
    ) =>
      (result?.properties.suppression as { status?: string } | undefined)
        ?.status ?? "none";

    it("labels a fully suppressed native shape with its reviewed reason", () => {
      const { results, gate } = analyze(
        set("1.2.13", [native]),
        config(entry("NATIVE", "reviewed prebuilt binding")),
      );
      expect(results).toEqual([
        expect.objectContaining({
          ruleId: "CAPDELTA-SHAPE-DYNAMIC-OR-NATIVE-CODE",
          level: "error",
          properties: expect.objectContaining({
            suppression: {
              status: "all",
              reasons: ["[version 1.2.13] reviewed prebuilt binding"],
            },
          }) as unknown,
        }),
      ]);
      expect(results[0]?.message.text).toContain(
        "Suppressed ([version 1.2.13] reviewed prebuilt binding)",
      );
      expect(gate.CRITICAL).toBe(0);
    });

    it("labels each per-capability shape independently", () => {
      const { results, gate } = analyze(
        set("1.2.13", [native, dynamic]),
        config(entry("NATIVE", "reviewed prebuilt binding")),
      );
      expect(results.map(statusOf).sort()).toEqual(["all", "none"]);
      expect(gate.CRITICAL).toBe(1);
    });

    it("never presents a partly suppressed multi-member shape as reviewed", () => {
      const { results, gate } = analyze(
        set("1.2.13", [net, env]),
        config(entry("NET", "reviewed telemetry")),
      );
      const shape = results.find(
        (result) => result.ruleId === "CAPDELTA-SHAPE-SECRET-EXFILTRATION",
      );
      expect(shape?.properties.suppression).toEqual({
        status: "partial",
        reasons: ["[version 1.2.13] reviewed telemetry"],
      });
      expect(shape?.message.text).toContain(
        "1 of 2 participants suppressed ([version 1.2.13] reviewed telemetry); the others still gate.",
      );
      expect(gate.CRITICAL).toBe(1);
    });

    describe("obfuscated-execution (signal and capability participants)", () => {
      const obfuscated = (): CapabilitySet => ({
        ...set("1.2.13", [process]),
        signals: buildSignalSet([
          observeSignalSource({
            file: "index.js",
            bytes: new TextEncoder().encode(
              "const t = [0x63, 0x61, 0x70, 0x64, 0x65, 0x6c, 0x74, 0x61];\n",
            ),
            parseState: "parsed",
          }),
        ]),
      });
      const PROCESS_REASON = "[version 1.2.13] reviewed process";
      const TABLE_REASON = "[version 1.2.13] reviewed table";

      it.each([
        ["neither", [], undefined, 2],
        [
          "the capability only",
          [entry("PROCESS", "reviewed process")],
          { status: "partial", reasons: [PROCESS_REASON] },
          1,
        ],
        [
          "the signal only",
          [entry("obfuscation-pattern-added", "reviewed table")],
          { status: "partial", reasons: [TABLE_REASON] },
          1,
        ],
        [
          "both",
          [
            entry("PROCESS", "reviewed process"),
            entry("obfuscation-pattern-added", "reviewed table"),
          ],
          { status: "all", reasons: [PROCESS_REASON, TABLE_REASON] },
          0,
        ],
      ] as const)(
        "labels %s suppressed consistently with the gate",
        (_label, entries, expected, critical) => {
          const { results, gate } = analyze(obfuscated(), config(...entries));
          const shapes = results.filter(
            (result) => result.ruleId === "CAPDELTA-SHAPE-OBFUSCATED-EXECUTION",
          );
          expect(shapes).toHaveLength(1);
          expect(shapes[0]?.properties.suppression).toEqual(expected);
          expect(gate.CRITICAL).toBe(critical);
          expect(
            results.filter((result) =>
              result.ruleId.startsWith("CAPDELTA-SIGNAL-"),
            ),
          ).toEqual([]);
        },
      );
    });

    it("bounds long reasons and deduplicates identical bounded reasons", () => {
      const long = "r".repeat(300);
      const { results } = analyze(
        set("1.2.13", [net, env]),
        config(entry("NET", `${long}A`), entry("ENV", `${long}B`)),
      );
      const shape = results.find(
        (result) => result.ruleId === "CAPDELTA-SHAPE-SECRET-EXFILTRATION",
      );
      const suppression = shape?.properties.suppression as {
        status: string;
        reasons: string[];
      };
      expect(suppression.status).toBe("all");
      expect(suppression.reasons).toHaveLength(1);
      expect(Array.from(suppression.reasons[0] ?? "")).toHaveLength(240);
    });

    it("emits no suppression label without an allowlist match", () => {
      const { results } = analyze(set("1.2.13", [native]), config());
      expect(results[0]?.properties.suppression).toBeUndefined();
      expect(results[0]?.message.text).not.toContain("uppressed");
    });
  });
});
