import { describe, expect, it } from "vitest";
import type { JsonRunReport } from "../src/core/report-contract.js";
import {
  groupIncompleteCauses,
  renderIncompleteCauses,
  type IncompleteAnalysis,
} from "./eval-incomplete.js";

interface PackageFixture {
  name: string;
  oldVersion: string;
  newVersion: string;
  diagnostics?: { side: "old" | "new"; kind: string; detail: string }[];
  issues?: {
    stage: string;
    kind: string;
    detail: string;
  }[];
  baselineFailures?: {
    stage: string;
    kind: string;
    detail: string;
  }[];
}

function analyzed(fixture: PackageFixture): IncompleteAnalysis {
  const diagnostics = fixture.diagnostics ?? [];
  return {
    id: `${fixture.name}:${fixture.oldVersion}->${fixture.newVersion}`,
    report: {
      packages: [
        {
          status: "analyzed",
          report: {
            package: {
              ecosystem: "npm",
              name: fixture.name,
              oldVersion: fixture.oldVersion,
              newVersion: fixture.newVersion,
              newPackage: false,
            },
            diagnostics,
          },
          issues: fixture.issues ?? [],
          baselineFailures: fixture.baselineFailures ?? [],
        },
      ],
      skipped: [],
    } as unknown as JsonRunReport,
  };
}

function unavailable(
  fixture: PackageFixture,
  kind: string,
  detail: string,
): IncompleteAnalysis {
  return {
    id: `${fixture.name}:${fixture.oldVersion}->${fixture.newVersion}`,
    report: {
      packages: [
        {
          status: "unavailable",
          package: {
            ecosystem: "npm",
            name: fixture.name,
            oldVersion: fixture.oldVersion,
            newVersion: fixture.newVersion,
            newPackage: false,
          },
          failures: [{ stage: "fetch", kind, detail }],
        },
      ],
      skipped: [],
    } as unknown as JsonRunReport,
  };
}

describe("group incomplete analysis causes", () => {
  it("groups the same message class across packages and versions", () => {
    const rows = groupIncompleteCauses([
      analyzed({
        name: "pkg-a",
        oldVersion: "1.0.0",
        newVersion: "1.0.1",
        diagnostics: [
          {
            side: "new",
            kind: "unsupported-source",
            detail:
              "src/a.ts is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode",
          },
        ],
      }),
      analyzed({
        name: "pkg-b",
        oldVersion: "2.3.4",
        newVersion: "2.3.5",
        diagnostics: [
          {
            side: "old",
            kind: "unsupported-source",
            detail:
              "lib/deep/b.ts is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode",
          },
        ],
      }),
      analyzed({
        name: "pkg-c",
        oldVersion: "3.0.0",
        newVersion: "3.0.1",
        diagnostics: [
          {
            side: "new",
            kind: "unparseable-source",
            detail:
              "JavaScript parse failed: SyntaxError: Unexpected token (3:0)",
          },
        ],
      }),
      analyzed({
        name: "pkg-d",
        oldVersion: "4.0.0",
        newVersion: "4.0.1",
        diagnostics: [
          {
            side: "new",
            kind: "unparseable-source",
            detail:
              "JavaScript parse failed: SyntaxError: Unexpected token (99:10)",
          },
        ],
      }),
    ]);

    expect(rows).toEqual([
      {
        cause:
          "unparseable-source: JavaScript parse failed: SyntaxError: Unexpected token (#:#)",
        count: 2,
        share: 0.5,
        example: "pkg-c@3.0.0->3.0.1",
      },
      {
        cause:
          "unsupported-source: <path> is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode",
        count: 2,
        share: 0.5,
        example: "pkg-a@1.0.0->1.0.1",
      },
    ]);
  });

  it("counts each release once under its first reported cause", () => {
    const rows = groupIncompleteCauses([
      analyzed({
        name: "pkg-issue",
        oldVersion: "1.0.0",
        newVersion: "1.0.1",
        issues: [
          {
            stage: "extract",
            kind: "unsafe-entry",
            detail: "entry ../escape is outside the package root",
          },
        ],
        diagnostics: [
          {
            side: "old",
            kind: "unsupported-source",
            detail: "src/a.ts is TypeScript that type stripping rejected: x",
          },
        ],
      }),
      analyzed({
        name: "pkg-dominant",
        oldVersion: "2.0.0",
        newVersion: "2.0.1",
        diagnostics: [
          {
            side: "old",
            kind: "unsupported-source",
            detail:
              "src/one.ts is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode",
          },
          {
            side: "new",
            kind: "unsupported-source",
            detail:
              "src/two.ts is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode",
          },
          {
            side: "new",
            kind: "unparseable-source",
            detail:
              "JavaScript parse failed: SyntaxError: Unexpected token (3:0)",
          },
        ],
      }),
      unavailable(
        { name: "pkg-fetch", oldVersion: "3.0.0", newVersion: "3.0.1" },
        "network-error",
        "https://registry.npmjs.org/pkg-fetch/-/pkg-fetch-3.0.1.tgz: HTTP 503",
      ),
    ]);

    expect(rows.map((row) => [row.cause, row.count, row.example])).toEqual([
      [
        "extract/unsafe-entry: entry <path> is outside the package root",
        1,
        "pkg-issue@1.0.0->1.0.1",
      ],
      [
        "unavailable fetch/network-error: <path> HTTP #",
        1,
        "pkg-fetch@3.0.0->3.0.1",
      ],
      [
        "unsupported-source: <path> is TypeScript that type stripping rejected: TypeScript enum is not supported in strip-only mode",
        1,
        "pkg-dominant@2.0.0->2.0.1",
      ],
    ]);
  });

  it("renders a markdown table with escaped cells", () => {
    const markdown = renderIncompleteCauses(
      [
        {
          cause: "unparseable-source: SyntaxError: a | b",
          count: 1,
          share: 0.25,
          example: "pkg@1.0.0->1.0.1",
        },
      ],
      4,
    );

    expect(markdown).toContain(
      "| Cause | Count | Share of incomplete | Example |",
    );
    expect(markdown).toContain(
      "| unparseable-source: SyntaxError: a \\| b | 1 | 25.0% | pkg@1.0.0->1.0.1 |",
    );
    expect(markdown).toContain("1 of 4 real-registry results are incomplete.");
  });
});
