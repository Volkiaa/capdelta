/* Test assertions intentionally inspect mocked object methods without binding. */
/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";
import type { CapabilityAnalysisRun } from "../core/capability-analysis-pipeline.js";
import {
  runAction,
  type ActionAdapters,
  type ActionContext,
  type ActionInputs,
} from "./run-action.js";

const SHA = "a".repeat(40);
const EMPTY_LOCKFILE = JSON.stringify({ lockfileVersion: 3, packages: {} });

function emptyRun(firstRun = false): CapabilityAnalysisRun {
  return {
    firstRun,
    summary: { changed: 0, analyzed: 0, unavailable: 0, skipped: 0 },
    packages: [],
    lockfileFindings: [],
    skipped: [],
  };
}

const inputs: ActionInputs = {
  lockfilePath: "package-lock.json",
  failOn: "CRITICAL",
  configPath: "",
  baseRef: "",
};

const context: ActionContext = {
  owner: "owner",
  repo: "repo",
  pullRequestNumber: 4,
  baseSha: SHA,
  headSha: "b".repeat(40),
  headRef: "feature",
  baseRepository: "owner/repo",
  headRepository: "owner/repo",
  actor: "contributor",
};

function adapters(run = emptyRun()): ActionAdapters {
  return {
    listChangedFiles: vi.fn().mockResolvedValue(["package-lock.json"]),
    resolveCommit: vi.fn().mockResolvedValue(SHA),
    contents: {
      getContent: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          type: "file",
          size: Buffer.byteLength(EMPTY_LOCKFILE),
          encoding: "base64",
          content: Buffer.from(EMPTY_LOCKFILE).toString("base64"),
        },
      }),
    },
    readHeadLockfile: vi.fn().mockResolvedValue(EMPTY_LOCKFILE),
    analyze: vi.fn().mockResolvedValue(run),
    uploadJson: vi.fn().mockResolvedValue({ id: 91, name: "capdelta-report" }),
    uploadSarif: vi.fn().mockResolvedValue(undefined),
    comments: {
      listComments: vi.fn().mockResolvedValue([]),
      createComment: vi.fn().mockResolvedValue({ id: 7 }),
      updateComment: vi.fn().mockResolvedValue(undefined),
    },
    addJobSummary: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn(),
    setOutput: vi.fn(),
  };
}

describe("runAction", () => {
  it("takes the no-op fast path before retrieval or analysis", async () => {
    const runtime = adapters();
    vi.mocked(runtime.listChangedFiles).mockResolvedValue(["README.md"]);
    await expect(runAction(inputs, context, runtime)).resolves.toEqual({
      status: "no-op",
    });
    expect(runtime.contents.getContent).not.toHaveBeenCalled();
    expect(runtime.analyze).not.toHaveBeenCalled();
    expect(runtime.uploadJson).not.toHaveBeenCalled();
  });

  it("retrieves, analyzes, uploads, comments, and gates a comparison", async () => {
    const runtime = adapters();
    await expect(runAction(inputs, context, runtime)).resolves.toMatchObject({
      status: "analyzed",
      firstRun: false,
      artifact: { id: 91 },
      comment: { status: "created", commentId: 7 },
      gate: { fail: false, threshold: "CRITICAL" },
      sarifUploaded: true,
    });
    expect(runtime.analyze).toHaveBeenCalledWith(
      { lockfileVersion: 3, packages: {} },
      { lockfileVersion: 3, packages: {} },
    );
    expect(runtime.uploadJson).toHaveBeenCalledWith(
      "capdelta-report",
      expect.stringContaining('"schemaVersion": 5'),
    );
    expect(runtime.uploadSarif).toHaveBeenCalledWith(
      expect.stringContaining('"version": "2.1.0"'),
      { commitSha: "b".repeat(40), ref: "refs/pull/4/head" },
    );
  });

  it("uploads integrity-mismatch SARIF located at the configured lockfile", async () => {
    const lockfilePath = "apps/web/package-lock.json";
    const tampered: CapabilityAnalysisRun = {
      firstRun: false,
      summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
      packages: [
        {
          status: "unavailable",
          changedPackage: {
            name: "tampered",
            oldVersion: "1.0.0",
            newVersion: "1.0.1",
            oldIntegrity: "sha512-old",
            newIntegrity: "sha512-new",
            oldResolvedUrl: "https://registry.npmjs.org/tampered/old.tgz",
            resolvedUrl: "https://registry.npmjs.org/tampered/new.tgz",
          },
          failures: [
            {
              stage: "fetch",
              failure: {
                side: "new",
                kind: "integrity-mismatch",
                detail:
                  "downloaded bytes do not match lockfile sha512 integrity",
                url: "https://registry.npmjs.org/tampered/new.tgz",
              },
            },
          ],
        },
      ],
      lockfileFindings: [],
      skipped: [],
    };
    const runtime = adapters(tampered);
    vi.mocked(runtime.listChangedFiles).mockResolvedValue([lockfilePath]);

    await expect(
      runAction({ ...inputs, lockfilePath }, context, runtime),
    ).resolves.toMatchObject({
      status: "analyzed",
      gate: { fail: true, threshold: "CRITICAL" },
      sarifUploaded: true,
    });
    const uploaded = vi.mocked(runtime.uploadSarif).mock.calls[0]?.[0];
    if (uploaded === undefined) throw new Error("SARIF was not uploaded");
    const sarif = JSON.parse(uploaded) as {
      runs: [{ results: { ruleId: string; locations: unknown[] }[] }];
    };
    expect(sarif.runs[0].results).toEqual([
      expect.objectContaining({
        ruleId: "CAPDELTA-INTEGRITY-MISMATCH",
        locations: [
          { physicalLocation: { artifactLocation: { uri: lockfilePath } } },
        ],
      }),
    ]);
  });

  it("uses a missing base lockfile as first-run mode", async () => {
    const runtime = adapters(emptyRun(true));
    vi.mocked(runtime.contents.getContent).mockResolvedValue({
      status: 404,
      data: null,
    });
    const outcome = await runAction(inputs, context, runtime);
    expect(outcome).toMatchObject({ status: "analyzed", firstRun: true });
    expect(runtime.analyze).toHaveBeenCalledWith(null, expect.anything());
    const createCall = vi.mocked(runtime.comments.createComment).mock.calls[0];
    expect(createCall?.[0].body).toContain("**First run:**");
  });

  it.each([
    [{ headRepository: "fork/repo" }, "fork"],
    [{ actor: "dependabot[bot]" }, "dependabot"],
  ] as const)(
    "degrades read-only contributions to summary",
    async (change, reason) => {
      const runtime = adapters();
      await expect(
        runAction(inputs, { ...context, ...change }, runtime),
      ).resolves.toMatchObject({ comment: { status: "summary-only", reason } });
      expect(runtime.addJobSummary).toHaveBeenCalledOnce();
      expect(runtime.comments.listComments).not.toHaveBeenCalled();
      expect(runtime.uploadSarif).not.toHaveBeenCalled();
      expect(runtime.warn).toHaveBeenCalledWith(
        expect.stringContaining("cannot upload SARIF"),
      );
    },
  );

  it("applies fail-on only after preserving report outputs", async () => {
    const critical = emptyRun();
    critical.summary = { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 };
    critical.packages = [
      {
        status: "analyzed",
        changedPackage: {
          name: "fixture",
          oldVersion: null,
          newVersion: "1.0.0",
          oldIntegrity: null,
          newIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
          oldResolvedUrl: null,
          resolvedUrl: "https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz",
        },
        diff: {
          baseline: null,
          subject: { ecosystem: "npm", name: "fixture", version: "1.0.0" },
          newPackage: true,
          findings: [
            {
              severity: "CRITICAL",
              change: "added",
              capability: {
                kind: "INSTALL_HOOK",
                location: {
                  kind: "install-script",
                  hook: "postinstall",
                  applicability: "registry-install",
                },
                contentDigest: { algorithm: "sha256", value: "a".repeat(64) },
                evidence: [
                  {
                    file: "package.json",
                    line: 1,
                    snippet: '"postinstall":"echo test"',
                  },
                ],
              },
              previous: null,
            },
          ],
          diagnostics: [],
        },
        issues: [],
      },
    ];
    const runtime = adapters(critical);
    await expect(runAction(inputs, context, runtime)).resolves.toMatchObject({
      gate: { fail: true, exitCode: 1 },
    });
    expect(runtime.uploadJson).toHaveBeenCalledOnce();
    expect(runtime.comments.createComment).toHaveBeenCalledOnce();
  });

  it("loads allowlist config and contextualizes artifact failures", async () => {
    const configured = adapters();
    configured.readConfig = vi
      .fn()
      .mockResolvedValue(
        'allowlist:\n  - package: fixture\n    capability: NET\n    justification: "documented endpoint"\n',
      );
    await expect(
      runAction(
        { ...inputs, configPath: ".capdelta.yml" },
        context,
        configured,
      ),
    ).resolves.toMatchObject({ status: "analyzed" });
    expect(configured.analyze).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        allowlist: [
          {
            package: "fixture",
            capability: "NET",
            justification: "documented endpoint",
          },
        ],
      },
    );

    const runtime = adapters();
    vi.mocked(runtime.uploadJson).mockRejectedValue(new Error("service down"));
    await expect(runAction(inputs, context, runtime)).rejects.toThrow(
      "failed to upload JSON report artifact",
    );
  });
});
