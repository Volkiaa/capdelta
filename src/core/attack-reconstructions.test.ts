import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
  type CapabilityAnalysisOptions,
  type CapabilityAnalysisRun,
} from "./capability-analysis-pipeline.js";
import { diffNpmLockfiles } from "./npm/lockfile-differ.js";
import { extractVerifiedTarball } from "./npm/safe-extractor.js";
import { parseCapdeltaConfig } from "./capdelta-config.js";
import {
  buildRunReport,
  type JsonReport,
  type JsonRunReport,
} from "./reporter.js";
import { evaluateSeverityGate } from "./run-severity.js";

// PLAN §7.4

const ROOT = fileURLToPath(
  new URL("../../test/fixtures/reconstructions/", import.meta.url),
);

interface Incident {
  name: string;
  scenarios: Record<string, { base: string[]; head: string[] }>;
  entryLinks?: Record<string, Record<string, string>>;
}

const INVENTORY = JSON.parse(
  await readFile(join(ROOT, "inventory.json"), "utf8"),
) as { incidents: Incident[] };

// ADR-017
const PLAIN_CRYPTO_INTEGRITY =
  "sha512-4hIzuzUVJZ5y9UzF2wNiqkC2SDjRZxaHOaQirl2S/j5OZQKD4G/yhEXuKPgrrWdIbPzZYbM3y6st1mX/YldOyQ==";
const AXIOS_INTEGRITY =
  "sha512-9AXKQFjUM2wtdjuqWH5IohcJqgLihPeqEsY4IeQ0YM7p7rqspw/ALUN+44os0YK5sSGrmqs80FDoKQrYy2Uigg==";
// ADR-017
const MANIFEST_DIRECTORY_INTEGRITY =
  "sha512-SRCqRyp8CchiQPiaRZcGn04wVa9Xk/BTb0sdONLnRA845HQtCfoJ4tUEVw39EE3FAb5Rq1t9UGa/jSAu4zHupQ==";

interface ScenarioResult {
  run: CapabilityAnalysisRun;
  report: JsonRunReport;
}

async function runScenario(
  incidentName: string,
  scenario: "attack" | "control",
  options: CapabilityAnalysisOptions = {},
): Promise<ScenarioResult> {
  const incident = INVENTORY.incidents.find(
    (item) => item.name === incidentName,
  );
  const sides = incident?.scenarios[scenario];
  if (sides === undefined) throw new Error(`no ${incidentName}/${scenario}`);
  const read = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(join(ROOT, incidentName, file), "utf8"));
  const [base, head] = await Promise.all([
    read(`${scenario}-base-lockfile.json`),
    read(`${scenario}-head-lockfile.json`),
  ]);

  const bytesByIntegrity = new Map<string, Uint8Array>();
  for (const id of [...sides.base, ...sides.head]) {
    const bytes = await readFile(
      join(ROOT, incidentName, "packages", `${id}.tgz`),
    );
    bytesByIntegrity.set(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      bytes,
    );
  }
  const bytesByUrl = new Map<string, Uint8Array>();
  for (const lockfile of [base, head] as {
    packages: Record<string, { resolved?: string; integrity?: string }>;
  }[]) {
    for (const entry of Object.values(lockfile.packages)) {
      if (entry.resolved === undefined || entry.integrity === undefined) {
        continue;
      }
      const bytes = bytesByIntegrity.get(entry.integrity);
      if (bytes !== undefined) bytesByUrl.set(entry.resolved, bytes);
    }
  }
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const bytes = bytesByUrl.get(url);
    if (bytes === undefined) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  };

  const run = await analyzeChangedPackages(diffNpmLockfiles(base, head), {
    ...options,
    fetcher: { fetchImpl },
  });
  return { run, report: buildRunReport(run) };
}

function packageReport(report: JsonRunReport, name: string): JsonReport {
  const item = report.packages.find(
    (candidate) =>
      candidate.status === "analyzed" && candidate.report.package.name === name,
  );
  if (item?.status !== "analyzed") throw new Error(`${name} not analyzed`);
  return item.report;
}

function findingsOf(report: JsonReport, kind: string) {
  return report.findings.filter((finding) => finding.capability.kind === kind);
}

function expectAllAnalyzed(
  result: ScenarioResult,
  count: number,
  { complete = true }: { complete?: boolean } = {},
): void {
  expect(result.report.summary).toMatchObject({
    changedPackages: count,
    analyzedPackages: count,
    unavailablePackages: 0,
    skippedLockfileEntries: 0,
  });
  if (complete) expect(hasUnanalyzedContent(result.run)).toBe(false);
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(relative(root, path));
  }
  return files.sort();
}

async function expectArchivedLinks(
  tarball: string,
  sourceRoot: string,
  links: Record<string, string>,
): Promise<void> {
  const found = new Map<string, string>();
  await tar.t({
    file: tarball,
    onReadEntry: (entry) => {
      if (entry.type === "SymbolicLink" || entry.type === "Link") {
        found.set(entry.path, entry.linkpath ?? "");
      }
    },
  });
  expect([...found.entries()].sort()).toEqual(Object.entries(links).sort());
  const work = await mkdtemp(join(tmpdir(), "capdelta-archive-"));
  try {
    // Extraction rejects this archive on purpose, so unpack its regular files
    // only and compare them to the reviewed source.
    await tar.x({
      file: tarball,
      cwd: work,
      strip: 1,
      filter: (_path, entry) =>
        !("type" in entry) ||
        (entry.type !== "SymbolicLink" && entry.type !== "Link"),
    });
    const files = await listFiles(sourceRoot);
    expect(await listFiles(work)).toEqual(files);
    for (const file of files) {
      expect(await readFile(join(work, file))).toEqual(
        await readFile(join(sourceRoot, file)),
      );
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe("reconstruction fixtures", () => {
  it.each(
    INVENTORY.incidents.flatMap((incident) =>
      [
        ...new Set(
          Object.values(incident.scenarios).flatMap((sides) => [
            ...sides.base,
            ...sides.head,
          ]),
        ),
      ].map((id) => [incident.name, id] as const),
    ),
  )(
    "%s/%s: committed archive matches its reviewed source",
    async (name, id) => {
      const packageRoot = join(ROOT, name, "packages", id);
      const roots = await readdir(packageRoot);
      expect(roots).toHaveLength(1);
      const [root] = roots;
      if (root === undefined) throw new Error(`${id} has no root directory`);
      const sourceRoot = join(packageRoot, root);
      const entryLinks = INVENTORY.incidents.find(
        (incident) => incident.name === name,
      )?.entryLinks?.[id];
      if (entryLinks !== undefined) {
        await expectArchivedLinks(
          join(ROOT, name, "packages", `${id}.tgz`),
          sourceRoot,
          entryLinks,
        );
        return;
      }
      const extraction = await extractVerifiedTarball({
        integrity: "sha512-inert-reconstruction",
        bytes: await readFile(`${packageRoot}.tgz`),
      });
      if (extraction.status !== "extracted") {
        throw new Error(`${id} rejected: ${extraction.failure.detail}`);
      }
      try {
        const files = await listFiles(sourceRoot);
        expect(await listFiles(extraction.root)).toEqual(files);
        for (const file of files) {
          expect(await readFile(join(extraction.root, file))).toEqual(
            await readFile(join(sourceRoot, file)),
          );
        }
      } finally {
        await extraction.cleanup();
      }
    },
  );
});

describe("axios npm compromise (2026-03-31) reconstruction", () => {
  it("fails the default gate on the laundered dependency's install hook", async () => {
    const result = await runScenario("axios-2026", "attack");
    expectAllAnalyzed(result, 2);

    const dropper = packageReport(result.report, "plain-crypto-js");
    expect(dropper.package.newPackage).toBe(true);
    expect(findingsOf(dropper, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
          applicability: "registry-install",
          evidence: [
            expect.objectContaining({
              file: "package.json",
              snippet: '"postinstall": "node setup.js"',
            }),
          ],
        }) as unknown,
      }),
    ]);
    expect(dropper.shapes?.map((shape) => shape.ruleId)).toContain(
      "install-hook-change",
    );
    // a string-table deobfuscator (PLAN §4.3).
    expect(findingsOf(dropper, "UNKNOWN")).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({
          location: expect.objectContaining({
            kind: "install-script",
          }) as unknown,
        }) as unknown,
      }),
    ]);

    const axios = packageReport(result.report, "axios");
    expect(axios.summary.bySeverity.CRITICAL).toBe(0);
    expect(findingsOf(axios, "DEPENDENCY")).toEqual([
      expect.objectContaining({
        severity: "LOW",
        relatedReportIds: [dropper.reportId],
      }),
    ]);

    expect(evaluateSeverityGate(result.report, "CRITICAL")).toMatchObject({
      fail: true,
      exitCode: 1,
      highest: "CRITICAL",
    });
  });

  it("passes the benign control bump", async () => {
    const result = await runScenario("axios-2026", "control");
    expectAllAnalyzed(result, 1);
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });

  it("fails the default gate when a resource cap hides the dropper", async () => {
    // ADR-016
    const result = await runScenario("axios-2026", "attack", {
      extractor: { maxFileCount: 3 },
    });
    expect(result.report.summary).toMatchObject({
      changedPackages: 2,
      analyzedPackages: 1,
      unavailablePackages: 1,
      skippedLockfileEntries: 0,
    });
    const dropper = result.report.packages.find(
      (item) => item.status === "unavailable",
    );
    expect(dropper).toEqual({
      status: "unavailable",
      package: expect.objectContaining({
        name: "plain-crypto-js",
        newVersion: "4.2.1",
      }) as unknown,
      failures: [
        expect.objectContaining({
          stage: "new-extraction",
          side: "new",
          kind: "file-count-limit",
          severity: "CRITICAL",
        }),
      ],
    });
    expect(packageReport(result.report, "axios").package.newVersion).toBe(
      "1.14.1",
    );
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(1);
    expect(evaluateSeverityGate(result.report, "CRITICAL")).toMatchObject({
      fail: true,
      exitCode: 1,
      highest: "CRITICAL",
    });
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });

  it("passes the default gate on the over-cap dropper with a reviewed exception (ADR-017)", async () => {
    const reviewed = parseCapdeltaConfig(
      "unanalyzable:\n" +
        "  - package: plain-crypto-js\n" +
        "    version: 4.2.1\n" +
        `    integrity: ${PLAIN_CRYPTO_INTEGRITY}\n` +
        "    kind: file-count-limit\n" +
        '    justification: "reviewed oversized fixture"\n',
    );
    const withException = await runScenario("axios-2026", "attack", {
      extractor: { maxFileCount: 3 },
      config: reviewed,
    });
    const dropper = withException.report.packages.find(
      (item) => item.status === "unavailable",
    );
    if (dropper?.status !== "unavailable") {
      throw new Error("plain-crypto-js must be unavailable under the cap");
    }
    expect(dropper.failures[0]).toMatchObject({
      kind: "file-count-limit",
      severity: "CRITICAL",
    });
    expect(dropper.exception?.reason).toContain("reviewed oversized fixture");
    expect(withException.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(
      evaluateSeverityGate(withException.report, "CRITICAL"),
    ).toMatchObject({
      fail: false,
      exitCode: 0,
    });
    expect(hasUnanalyzedContent(withException.run)).toBe(true);

    const swapped = await runScenario("axios-2026", "attack", {
      extractor: { maxFileCount: 3 },
      config: parseCapdeltaConfig(
        "unanalyzable:\n" +
          "  - package: plain-crypto-js\n" +
          "    version: 4.2.1\n" +
          `    integrity: ${AXIOS_INTEGRITY}\n` +
          "    kind: file-count-limit\n" +
          '    justification: "reviewed oversized fixture"\n',
      ),
    });
    expect(evaluateSeverityGate(swapped.report, "CRITICAL").fail).toBe(true);
    expect(hasUnanalyzedContent(swapped.run)).toBe(true);
  });

  it("fails the default gate on a rejected link entry", async () => {
    const work = await mkdtemp(join(tmpdir(), "capdelta-link-"));
    try {
      await mkdir(join(work, "package"), { recursive: true });
      await writeFile(
        join(work, "package", "package.json"),
        '{"name":"link-bomb","version":"1.0.0"}\n',
        "utf8",
      );
      await symlink("../../outside", join(work, "package", "link"));
      const archive = join(work, "link-bomb.tgz");
      await tar.c(
        {
          cwd: work,
          file: archive,
          gzip: true,
          portable: true,
          mtime: new Date(0),
        },
        ["package"],
      );
      const bytes = await readFile(archive);
      const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
      const url = "https://registry.npmjs.org/link-bomb/-/link-bomb-1.0.0.tgz";
      const base = {
        name: "link-project",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "link-project", version: "1.0.0" } },
      };
      const head = {
        ...base,
        packages: {
          "": { name: "link-project", version: "1.0.0" },
          "node_modules/link-bomb": {
            version: "1.0.0",
            resolved: url,
            integrity,
          },
        },
      };
      const fetchImpl: typeof fetch = (input) => {
        const requestUrl =
          input instanceof Request ? input.url : input.toString();
        if (requestUrl !== url) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { "content-length": String(bytes.length) },
          }),
        );
      };

      const run = await analyzeChangedPackages(diffNpmLockfiles(base, head), {
        fetcher: { fetchImpl },
      });
      const report = buildRunReport(run);
      expect(report.summary).toMatchObject({
        changedPackages: 1,
        analyzedPackages: 0,
        unavailablePackages: 1,
      });
      const item = report.packages[0];
      if (item?.status !== "unavailable") {
        throw new Error("link-entry fixture must be unavailable");
      }
      expect(item.failures[0]).toMatchObject({
        stage: "new-extraction",
        side: "new",
        kind: "link-entry",
        severity: "CRITICAL",
      });
      expect(evaluateSeverityGate(report, "CRITICAL")).toMatchObject({
        fail: true,
        exitCode: 1,
      });
      expect(hasUnanalyzedContent(run)).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe("Shai-Hulud worm (2025-09) reconstruction", () => {
  it("fails the default gate on the postinstall bundle and its shapes", async () => {
    const result = await runScenario("shai-hulud-2025", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(result.report, "@ctrl/tinycolor");

    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
        }) as unknown,
      }),
    ]);
    for (const kind of ["NET", "ENV", "PROCESS"]) {
      expect(findingsOf(report, kind)).toEqual([
        expect.objectContaining({
          severity: "CRITICAL",
          capability: expect.objectContaining({
            location: expect.objectContaining({
              kind: "install-script",
            }) as unknown,
            evidence: expect.arrayContaining([
              expect.objectContaining({ file: "bundle.js" }),
            ]) as unknown,
          }) as unknown,
        }),
      ]);
    }
    expect(report.shapes?.map((shape) => shape.ruleId)).toEqual(
      expect.arrayContaining([
        "install-hook-change",
        "install-code-execution",
        "secret-exfiltration",
      ]),
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });

  it("still fails on the hook in a parser-limit simulation on the reduced bundle", async () => {
    const bundle = await readFile(
      join(ROOT, "shai-hulud-2025/packages/tinycolor-4.1.1/package/bundle.js"),
    );
    const result = await runScenario("shai-hulud-2025", "attack", {
      astExtractor: { maxSourceBytes: bundle.byteLength - 1 },
    });
    expectAllAnalyzed(result, 1, { complete: false });
    const report = packageReport(result.report, "@ctrl/tinycolor");

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining("bundle.js exceeds") as unknown,
      }),
    ]);
    for (const kind of ["NET", "ENV", "PROCESS"]) {
      expect(findingsOf(report, kind)).toEqual([]);
    }
    expect(findingsOf(report, "INSTALL_HOOK")[0]?.severity).toBe("CRITICAL");
    expect(report.signalFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "new-external-endpoint",
          detail: expect.stringContaining("api.github.example.test") as unknown,
        }),
      ]),
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });

  it("passes the benign control bump", async () => {
    const result = await runScenario("shai-hulud-2025", "control");
    expectAllAnalyzed(result, 1);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });
});

describe("Shai-Hulud 2.0 (2025-11) reconstruction", () => {
  it("fails the default gate on the preinstall loader hook", async () => {
    const result = await runScenario("shai-hulud-2-2025", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(result.report, "reconstructed-sh2-victim");

    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "preinstall",
          applicability: "registry-install",
          evidence: [
            expect.objectContaining({
              file: "package.json",
              snippet: '"preinstall": "node setup_bun.js"',
            }),
          ],
        }) as unknown,
      }),
    ]);
    expect(report.shapes?.map((shape) => shape.ruleId)).toContain(
      "install-hook-change",
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });

  it("passes the benign control bump", async () => {
    const result = await runScenario("shai-hulud-2-2025", "control");
    expectAllAnalyzed(result, 1);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });
});

describe("synthetic layout evasion (ADR-013)", () => {
  it("analyzes a hook in an archive rooted at x/ instead of reporting it unavailable", async () => {
    // npm installs any single-root tarball (strip one component), so a root
    // other than package/ must not hide the hook from the default gate.
    const result = await runScenario("layout-evasion", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-layout-evasion",
    );
    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
          applicability: "registry-install",
        }) as unknown,
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });
});

describe("synthetic mode evasion (ADR-019)", () => {
  it("reads and analyzes a mode-000 manifest and hook instead of hiding them", async () => {
    // The attack tarball stores package.json and hook.js with mode 000, which
    // an unprivileged runner could not read before mode normalization. npm
    // makes the hook bytes readable; executable malicious code could exploit
    // the same modes.
    const result = await runScenario("mode-evasion", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-mode-evasion",
    );

    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
          applicability: "registry-install",
        }) as unknown,
      }),
    ]);
    for (const kind of ["PROCESS", "ENV"]) {
      expect(findingsOf(report, kind)).toEqual([
        expect.objectContaining({
          severity: "CRITICAL",
          capability: expect.objectContaining({
            location: expect.objectContaining({
              kind: "install-script",
            }) as unknown,
            evidence: expect.arrayContaining([
              expect.objectContaining({ file: "hook.js" }),
            ]) as unknown,
          }) as unknown,
        }),
      ]);
    }
    expect(findingsOf(report, "unparseable-file")).toEqual([]);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(true);
  });

  it("passes the benign control bump without mode tricks", async () => {
    const result = await runScenario("mode-evasion", "control");
    expectAllAnalyzed(result, 1);
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });
});

describe("synthetic unanalyzable baseline (ADR-023)", () => {
  it("analyzes the new version as newly added when only the old tarball has a link entry", async () => {
    const result = await runScenario("old-side-unanalyzable", "attack");
    expect(result.report.summary).toMatchObject({
      changedPackages: 1,
      analyzedPackages: 1,
      unavailablePackages: 0,
      skippedLockfileEntries: 0,
    });
    const item = result.report.packages[0];
    if (item?.status !== "analyzed") {
      throw new Error("old-side-unanalyzable fixture must be analyzed");
    }
    expect(item.baselineFailures).toEqual([
      expect.objectContaining({
        stage: "old-extraction",
        side: "old",
        kind: "link-entry",
        severity: "CRITICAL",
      }),
    ]);
    const report = packageReport(
      result.report,
      "capdelta-fixture-old-side-unanalyzable",
    );
    expect(report.package.newPackage).toBe(true);
    expect(findingsOf(report, "INSTALL_HOOK")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        capability: expect.objectContaining({
          hook: "postinstall",
          applicability: "registry-install",
        }) as unknown,
      }),
    ]);
    expect(result.report.summary.gateSeverity.CRITICAL).toBeGreaterThanOrEqual(
      1,
    );
    expect(evaluateSeverityGate(result.report, "CRITICAL")).toMatchObject({
      fail: true,
      exitCode: 1,
    });
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });

  it("passes the default gate on a clean new version and keeps the baseline failure", async () => {
    const result = await runScenario("old-side-unanalyzable", "control");
    expect(result.report.summary).toMatchObject({
      changedPackages: 1,
      analyzedPackages: 1,
      unavailablePackages: 0,
    });
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
    const item = result.report.packages[0];
    if (item?.status !== "analyzed") {
      throw new Error("old-side-unanalyzable control must be analyzed");
    }
    expect(item.baselineFailures).not.toHaveLength(0);
    expect(item.baselineFailures[0]).toMatchObject({
      stage: "old-extraction",
      kind: "link-entry",
    });
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });
});

describe("synthetic non-regular manifest evasion (ADR-019)", () => {
  it("analyzes the new version as newly added when package.json is a directory (ADR-023)", async () => {
    const result = await runScenario("manifest-directory", "attack");
    expect(result.report.summary).toMatchObject({
      changedPackages: 1,
      analyzedPackages: 1,
      unavailablePackages: 0,
      skippedLockfileEntries: 0,
    });
    const item = result.report.packages.find(
      (candidate) => candidate.status === "analyzed",
    );
    if (item?.status !== "analyzed") {
      throw new Error("manifest-directory fixture must be analyzed");
    }
    expect(item.report.package.newPackage).toBe(true);
    expect(item.baselineFailures[0]).toMatchObject({
      stage: "old-manifest",
      side: "old",
      kind: "manifest-not-regular",
      severity: "CRITICAL",
    });
    expect(result.report.summary.gateSeverity.CRITICAL).toBe(0);
    expect(evaluateSeverityGate(result.report, "CRITICAL")).toMatchObject({
      fail: false,
      exitCode: 0,
    });
    expect(hasUnanalyzedContent(result.run)).toBe(true);
  });

  it("analyzes the package despite an old-side-only exception because the new side is clean (ADR-023)", async () => {
    const reviewed = parseCapdeltaConfig(
      "unanalyzable:\n" +
        "  - package: capdelta-fixture-manifest-directory\n" +
        "    version: 1.0.0\n" +
        `    integrity: ${MANIFEST_DIRECTORY_INTEGRITY}\n` +
        "    kind: manifest-not-regular\n" +
        '    justification: "reviewed non-regular old manifest"\n',
    );
    const result = await runScenario("manifest-directory", "attack", {
      config: reviewed,
    });
    const item = result.report.packages.find(
      (candidate) => candidate.status === "analyzed",
    );
    if (item?.status !== "analyzed") {
      throw new Error("manifest-directory fixture must be analyzed");
    }
    expect(item.baselineFailures[0]).toMatchObject({
      kind: "manifest-not-regular",
      severity: "CRITICAL",
    });
    expect(evaluateSeverityGate(result.report, "CRITICAL").fail).toBe(false);
  });
});

describe("synthetic template element boundary (ADR-024)", () => {
  it("reports the host fetched from the element after the expression as a new HIGH endpoint", async () => {
    const result = await runScenario("template-boundary", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-template-boundary",
    );

    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain docs.example.test",
      }),
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain exfil.example.test",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});

describe("synthetic escaped-string endpoint (ADR-026)", () => {
  it("reports the host hidden behind a glued escape as a new HIGH endpoint", async () => {
    const result = await runScenario("escaped-url", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(result.report, "capdelta-fixture-escaped-url");

    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain exfil.example.test",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});

describe("synthetic underscore-label endpoint (ADR-029)", () => {
  it("reports a host with an underscore in a label as a new HIGH endpoint", async () => {
    const result = await runScenario("underscore-label", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-underscore-label",
    );

    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain a_b.exfil.example.test",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});

describe("synthetic extensionless Node bin script (ADR-030)", () => {
  it("reports the host fetched by the new bin script as a new HIGH endpoint", async () => {
    const result = await runScenario("file-kinds", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(result.report, "capdelta-fixture-file-kinds");

    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain exfil.example.test",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});

describe("synthetic inet_aton IPv4 host (ADR-031)", () => {
  it("reports the hex-part host as a new HIGH endpoint", async () => {
    const result = await runScenario("ipv4-octal-hex", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-ipv4-octal-hex",
    );

    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external ipv4 93.184.216.34",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});

describe("synthetic scheme forms (ADR-033)", () => {
  it("reports the destination swap written with an upper-case scheme and backslashes", async () => {
    const result = await runScenario("scheme-forms", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-scheme-forms",
    );

    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain exfil.example.test",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});

describe("synthetic authority separator regression (ADR-033)", () => {
  it("reports a host hidden by main's prefix without counting the old path", async () => {
    const result = await runScenario("scheme-authority", "attack");
    expectAllAnalyzed(result, 1);
    const report = packageReport(
      result.report,
      "capdelta-fixture-scheme-authority",
    );
    expect(report.signalFindings).toEqual([
      expect.objectContaining({
        kind: "new-external-endpoint",
        severity: "HIGH",
        detail: "new external domain exfil.example.test",
      }),
    ]);
    expect(evaluateSeverityGate(result.report, "HIGH").fail).toBe(true);
  });
});
