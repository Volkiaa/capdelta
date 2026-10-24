import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityAnalysisRun,
  PackageAnalysisFailure,
} from "../core/capability-analysis-pipeline.js";
import {
  applyCapabilityAllowlist,
  emptyCapdeltaConfig,
  type CapdeltaConfig,
} from "../core/capdelta-config.js";
import { diffCapabilities } from "../core/capability-differ.js";
import {
  actionFailureMessage,
  runAction,
  type ActionAdapters,
  type ActionContext,
  type ActionInputs,
} from "./run-action.js";

const SHA = "a".repeat(40);
const EMPTY_LOCKFILE = JSON.stringify({ lockfileVersion: 3, packages: {} });

const OLD_LOCKFILE = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "fixture", version: "1.0.0" },
    "node_modules/bad": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/bad/-/bad-1.0.0.tgz",
      integrity: "sha512-old",
    },
  },
});
const NEW_LOCKFILE = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "fixture", version: "1.0.0" },
    "node_modules/bad": {
      version: "1.1.0",
      resolved: "https://registry.npmjs.org/bad/-/bad-1.1.0.tgz",
      integrity: "sha512-bad",
    },
  },
});
const INTEL_ID = "CDI-0123456789abcdef0123";

function emptyRun(firstRun = false): CapabilityAnalysisRun {
  return {
    firstRun,
    summary: { changed: 0, analyzed: 0, unavailable: 0, skipped: 0 },
    packages: [],
    lockfileFindings: [],
    skipped: [],
  };
}

function fetchFailure(
  kind: "network-error" | "integrity-mismatch",
): PackageAnalysisFailure {
  return {
    stage: "fetch",
    failure: {
      side: "new",
      kind,
      detail: kind === "network-error" ? "connection reset" : "mismatch",
      url: "https://registry.npmjs.org/flaky/-/flaky-1.1.0.tgz",
    },
  };
}

function unavailableRun(
  failures: readonly [PackageAnalysisFailure, ...PackageAnalysisFailure[]],
): CapabilityAnalysisRun {
  return {
    firstRun: false,
    summary: { changed: 1, analyzed: 0, unavailable: 1, skipped: 0 },
    packages: [
      {
        status: "unavailable",
        changedPackage: {
          name: "flaky",
          oldVersion: "1.0.0",
          newVersion: "1.1.0",
          oldIntegrity: "sha512-old",
          newIntegrity: "sha512-new",
          oldResolvedUrl: "https://registry.npmjs.org/flaky/-/flaky-1.0.0.tgz",
          resolvedUrl: "https://registry.npmjs.org/flaky/-/flaky-1.1.0.tgz",
        },
        failures,
      },
    ],
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

function adapters(run = emptyRun(), fetchImpl?: typeof fetch) {
  const listChangedFiles = vi
    .fn<ActionAdapters["listChangedFiles"]>()
    .mockResolvedValue(["package-lock.json"]);
  const resolveCommit = vi
    .fn<ActionAdapters["resolveCommit"]>()
    .mockResolvedValue(SHA);
  const getContent = vi
    .fn<ActionAdapters["contents"]["getContent"]>()
    .mockResolvedValue({
      status: 200,
      data: {
        type: "file",
        size: Buffer.byteLength(EMPTY_LOCKFILE),
        encoding: "base64",
        content: Buffer.from(EMPTY_LOCKFILE).toString("base64"),
      },
    });
  const readHeadLockfile = vi
    .fn<ActionAdapters["readHeadLockfile"]>()
    .mockResolvedValue(EMPTY_LOCKFILE);
  const analyze = vi.fn<ActionAdapters["analyze"]>().mockResolvedValue(run);
  const uploadJson = vi
    .fn<ActionAdapters["uploadJson"]>()
    .mockResolvedValue({ id: 91, name: "capdelta-report" });
  const uploadSarif = vi
    .fn<ActionAdapters["uploadSarif"]>()
    .mockResolvedValue(undefined);
  const listComments = vi
    .fn<ActionAdapters["comments"]["listComments"]>()
    .mockResolvedValue([]);
  const createComment = vi
    .fn<ActionAdapters["comments"]["createComment"]>()
    .mockResolvedValue({ id: 7 });
  const updateComment = vi
    .fn<ActionAdapters["comments"]["updateComment"]>()
    .mockResolvedValue(undefined);
  const addJobSummary = vi
    .fn<ActionAdapters["addJobSummary"]>()
    .mockResolvedValue(undefined);
  const warn = vi.fn<ActionAdapters["warn"]>();
  const setOutput = vi.fn<ActionAdapters["setOutput"]>();
  return {
    listChangedFiles,
    resolveCommit,
    contents: { getContent },
    readHeadLockfile,
    analyze,
    uploadJson,
    uploadSarif,
    comments: { listComments, createComment, updateComment },
    addJobSummary,
    warn,
    setOutput,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
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

  it("degrades a fork PR to the job summary without attempting any write", async () => {
    const runtime = adapters();
    await expect(
      runAction(inputs, { ...context, headRepository: "fork/repo" }, runtime),
    ).resolves.toMatchObject({
      comment: { status: "summary-only", reason: "fork" },
    });
    expect(runtime.addJobSummary).toHaveBeenCalledOnce();
    expect(runtime.comments.listComments).not.toHaveBeenCalled();
    expect(runtime.comments.createComment).not.toHaveBeenCalled();
    expect(runtime.comments.updateComment).not.toHaveBeenCalled();
    expect(runtime.uploadSarif).not.toHaveBeenCalled();
    expect(runtime.warn).toHaveBeenCalledWith(
      expect.stringContaining("fork PR cannot upload SARIF"),
    );
  });

  it("posts the comment and uploads SARIF for a non-fork Dependabot PR (ADR-020)", async () => {
    const runtime = adapters();
    await expect(
      runAction(inputs, { ...context, actor: "dependabot[bot]" }, runtime),
    ).resolves.toMatchObject({
      comment: { status: "created", commentId: 7 },
      sarifUploaded: true,
    });
    expect(runtime.comments.createComment).toHaveBeenCalledOnce();
    expect(runtime.uploadSarif).toHaveBeenCalledOnce();
  });

  it("warns and continues when the SARIF upload is refused for a missing permission (ADR-020)", async () => {
    const runtime = adapters();
    vi.mocked(runtime.uploadSarif).mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
      }),
    );
    await expect(runAction(inputs, context, runtime)).resolves.toMatchObject({
      status: "analyzed",
      sarifUploaded: false,
      comment: { status: "created", commentId: 7 },
    });
    expect(runtime.warn).toHaveBeenCalledWith(
      expect.stringContaining("security-events: write"),
    );
    expect(runtime.comments.createComment).toHaveBeenCalledOnce();
  });

  it("fails the run when the SARIF upload fails for any other reason (ADR-020)", async () => {
    const runtime = adapters();
    vi.mocked(runtime.uploadSarif).mockRejectedValueOnce(
      Object.assign(new Error("server error"), { status: 500 }),
    );
    await expect(runAction(inputs, context, runtime)).rejects.toThrow(
      "failed to upload SARIF report",
    );
  });

  it("keeps the gate failing when a refused comment write degrades to the summary (ADR-020)", async () => {
    const runtime = adapters(
      unavailableRun([fetchFailure("integrity-mismatch")]),
    );
    vi.mocked(runtime.comments.createComment).mockRejectedValueOnce(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
      }),
    );
    const outcome = await runAction(inputs, context, runtime);
    expect(outcome).toMatchObject({
      gate: { fail: true },
      comment: { status: "summary-only", reason: "token-denied" },
    });
    expect(runtime.addJobSummary).toHaveBeenCalledOnce();
  });

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
        baselineFailures: [],
      },
    ];
    const runtime = adapters(critical);
    await expect(runAction(inputs, context, runtime)).resolves.toMatchObject({
      gate: { fail: true, exitCode: 1 },
    });
    expect(runtime.uploadJson).toHaveBeenCalledOnce();
    expect(runtime.comments.createComment).toHaveBeenCalledOnce();
  });

  it("fails operationally for a transient fetch failure, even with fail-on none (ADR-018)", async () => {
    const runtime = adapters(unavailableRun([fetchFailure("network-error")]));
    await expect(
      runAction({ ...inputs, failOn: "none" }, context, runtime),
    ).resolves.toMatchObject({
      status: "analyzed",
      gate: { fail: false },
      operationalFailure: true,
      operationalFailureCount: 1,
    });
    expect(runtime.setOutput).toHaveBeenCalledWith("status", "failed");
  });

  it("reports a gate failure and an operational failure together (ADR-018)", async () => {
    const runtime = adapters(
      unavailableRun([
        fetchFailure("integrity-mismatch"),
        fetchFailure("network-error"),
      ]),
    );
    await expect(runAction(inputs, context, runtime)).resolves.toMatchObject({
      gate: { fail: true },
      operationalFailure: true,
      operationalFailureCount: 1,
    });
  });

  it("does not flag a deterministic fetch failure as operational (ADR-018)", async () => {
    const runtime = adapters(
      unavailableRun([fetchFailure("integrity-mismatch")]),
    );
    await expect(runAction(inputs, context, runtime)).resolves.toMatchObject({
      gate: { fail: true },
      operationalFailure: false,
      operationalFailureCount: 0,
    });
  });

  it("fails operationally on a residual filesystem or manifest-read failure (ADR-019)", async () => {
    const residualFailures: PackageAnalysisFailure[] = [
      {
        stage: "old-extraction",
        failure: { kind: "filesystem-error", detail: "input/output error" },
      },
      {
        stage: "new-manifest",
        failure: {
          kind: "manifest-unreadable",
          detail: "package.json could not be read: EACCES",
          evidence: null,
        },
      },
    ];
    for (const failure of residualFailures) {
      const runtime = adapters(unavailableRun([failure]));
      const outcome = await runAction(
        { ...inputs, failOn: "none" },
        context,
        runtime,
      );
      expect(outcome).toMatchObject({
        status: "analyzed",
        gate: { fail: false },
        operationalFailure: true,
        operationalFailureCount: 1,
      });
      if (outcome.status !== "analyzed") throw new Error("expected analyzed");
      expect(
        actionFailureMessage({
          gate: outcome.gate,
          operationalFailure: outcome.operationalFailure,
          operationalFailureCount: outcome.operationalFailureCount,
          strictFailure: outcome.strictFailure,
        }),
      ).toBe("capdelta: 1 package(s) could not be fetched or analyzed");
      expect(runtime.setOutput).toHaveBeenCalledWith("status", "failed");
    }
  });

  describe("actionFailureMessage (ADR-018)", () => {
    const passing = {
      fail: false,
      matchingCount: 0,
      threshold: "CRITICAL",
    } as const;
    const failing = {
      fail: true,
      matchingCount: 2,
      threshold: "HIGH",
    } as const;
    const operationalMessage =
      "capdelta: 3 package(s) could not be fetched or analyzed";

    it("returns null when the run passes", () => {
      expect(
        actionFailureMessage({
          gate: passing,
          operationalFailure: false,
          operationalFailureCount: 0,
          strictFailure: false,
        }),
      ).toBeNull();
    });

    it("reports a strict failure as the fallback", () => {
      expect(
        actionFailureMessage({
          gate: passing,
          operationalFailure: false,
          operationalFailureCount: 0,
          strictFailure: true,
        }),
      ).toBe("Strict mode found unanalyzed content.");
    });

    it("reports an operational failure alone, even in report-only mode", () => {
      expect(
        actionFailureMessage({
          gate: passing,
          operationalFailure: true,
          operationalFailureCount: 3,
          strictFailure: false,
        }),
      ).toBe(operationalMessage);
    });

    it("joins the gate and operational messages so neither is hidden", () => {
      expect(
        actionFailureMessage({
          gate: failing,
          operationalFailure: true,
          operationalFailureCount: 3,
          strictFailure: false,
        }),
      ).toBe(
        "Review this change: 2 finding(s) meet the HIGH failure threshold. " +
          operationalMessage,
      );
    });
  });

  describe("allowlist policy comes from the base commit (ADR-015)", () => {
    const CONFIG =
      'allowlist:\n  - package: fixture\n    capability: NET\n    justification: "documented endpoint"\n';
    const ALLOWLIST = {
      allowlist: [
        {
          package: "fixture",
          capability: "NET",
          justification: "documented endpoint",
        },
      ],
      unanalyzable: [],
    };

    function withBaseConfig(config: string | null | Error) {
      const runtime = adapters();
      vi.mocked(runtime.listChangedFiles).mockResolvedValue([
        "package-lock.json",
      ]);
      vi.mocked(runtime.contents.getContent).mockImplementation((request) => {
        if (request.path === ".capdelta.yml") {
          if (config instanceof Error) return Promise.reject(config);
          if (config === null) {
            return Promise.reject(
              Object.assign(new Error("Not Found"), { status: 404 }),
            );
          }
          return Promise.resolve({
            status: 200,
            data: {
              type: "file",
              size: Buffer.byteLength(config),
              encoding: "base64",
              content: Buffer.from(config).toString("base64"),
            },
          });
        }
        return Promise.resolve({
          status: 200,
          data: {
            type: "file",
            size: Buffer.byteLength(EMPTY_LOCKFILE),
            encoding: "base64",
            content: Buffer.from(EMPTY_LOCKFILE).toString("base64"),
          },
        });
      });
      return runtime;
    }
    const configured = { ...inputs, configPath: ".capdelta.yml" };

    it("applies the base commit's policy, read at the base SHA", async () => {
      const runtime = withBaseConfig(CONFIG);
      await expect(
        runAction(configured, context, runtime),
      ).resolves.toMatchObject({
        status: "analyzed",
      });
      expect(runtime.contents.getContent).toHaveBeenCalledWith(
        { owner: "owner", repo: "repo", path: ".capdelta.yml", ref: SHA },
        "object",
      );
      expect(runtime.analyze).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        ALLOWLIST,
      );
      expect(runtime.warn).not.toHaveBeenCalled();
    });

    it("reads policy at an overridden base-ref's resolved commit", async () => {
      const override = "c".repeat(40);
      const runtime = withBaseConfig(CONFIG);
      vi.mocked(runtime.resolveCommit).mockResolvedValue(override);
      await runAction({ ...configured, baseRef: "release" }, context, runtime);
      expect(runtime.contents.getContent).toHaveBeenCalledWith(
        expect.objectContaining({ path: ".capdelta.yml", ref: override }),
        "object",
      );
    });

    it("ignores a PR-added config: no exceptions apply, with warnings", async () => {
      const runtime = withBaseConfig(null);
      vi.mocked(runtime.listChangedFiles).mockResolvedValue([
        "package-lock.json",
        ".capdelta.yml",
      ]);
      await runAction(configured, context, runtime);
      expect(runtime.analyze).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        {
          allowlist: [],
          unanalyzable: [],
        },
      );
      expect(vi.mocked(runtime.warn).mock.calls.flat()).toEqual([
        "capdelta: this PR changes .capdelta.yml; policy is read from the selected base commit, so those changes do not apply to this run",
        `capdelta: .capdelta.yml is not present at base ${SHA}; no exceptions applied`,
      ]);
    });

    it("keeps base policy when the PR edits the config", async () => {
      const runtime = withBaseConfig(CONFIG);
      vi.mocked(runtime.listChangedFiles).mockResolvedValue([
        "package-lock.json",
        ".capdelta.yml",
      ]);
      await runAction(configured, context, runtime);
      expect(runtime.analyze).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        ALLOWLIST,
      );
      expect(runtime.warn).toHaveBeenCalledOnce();
    });

    it("fails loudly on invalid base policy or a failed read, never using empty policy", async () => {
      await expect(
        runAction(
          configured,
          context,
          withBaseConfig("allowlist:\n  - package: x\n"),
        ),
      ).rejects.toThrow("base config is invalid");
      const serverError = Object.assign(new Error("boom"), { status: 500 });
      const runtime = withBaseConfig(serverError);
      await expect(runAction(configured, context, runtime)).rejects.toThrow(
        "failed to read base config",
      );
      expect(runtime.analyze).not.toHaveBeenCalled();
    });

    it("rejects an unsafe config-path input", async () => {
      await expect(
        runAction(
          { ...inputs, configPath: "../outside.yml" },
          context,
          adapters(),
        ),
      ).rejects.toThrow("config-path must be a normalized relative POSIX path");
    });

    describe("gate effect with a real Differ and allowlist", () => {
      const EXCEPTION =
        'allowlist:\n  - package: binding\n    capability: NATIVE\n    version: 1.2.13\n    justification: "reviewed prebuilt binding"\n';
      const nativeRun = (config: CapdeltaConfig): CapabilityAnalysisRun => ({
        firstRun: false,
        summary: { changed: 1, analyzed: 1, unavailable: 0, skipped: 0 },
        packages: [
          {
            status: "analyzed",
            changedPackage: {
              name: "binding",
              oldVersion: null,
              newVersion: "1.2.13",
              oldIntegrity: null,
              newIntegrity: "sha512-new",
              oldResolvedUrl: null,
              resolvedUrl:
                "https://registry.npmjs.org/binding/-/binding-1.2.13.tgz",
            },
            diff: applyCapabilityAllowlist(
              diffCapabilities(null, {
                schemaVersion: 1,
                subject: {
                  ecosystem: "npm",
                  name: "binding",
                  version: "1.2.13",
                },
                completeness: "complete",
                capabilities: [
                  {
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
                ],
                diagnostics: [],
              }),
              config,
            ),
            issues: [],
            baselineFailures: [],
          },
        ],
        lockfileFindings: [],
        skipped: [],
      });
      const run = async (
        baseConfig: string | null,
        changed: readonly string[],
      ) => {
        const runtime = withBaseConfig(baseConfig);
        vi.mocked(runtime.listChangedFiles).mockResolvedValue(changed);
        vi.mocked(runtime.analyze).mockImplementation((_old, _head, config) =>
          Promise.resolve(nativeRun(config ?? emptyCapdeltaConfig())),
        );
        const outcome = await runAction(configured, context, runtime);
        const json = vi.mocked(runtime.uploadJson).mock.calls[0]?.[1] ?? "";
        return { outcome, json };
      };

      it("keeps the gate failing when only the PR adds the exception", async () => {
        const { outcome, json } = await run(null, [
          "package-lock.json",
          ".capdelta.yml",
        ]);
        expect(outcome).toMatchObject({
          gate: { fail: true, matchingCount: 1 },
        });
        expect(json).not.toContain("reviewed prebuilt binding");
      });

      it.each([
        ["unchanged by the PR", ["package-lock.json"]],
        ["edited or removed by the PR", ["package-lock.json", ".capdelta.yml"]],
      ])(
        "passes with the reviewed exception at base, %s",
        async (_label, changed) => {
          const { outcome, json } = await run(EXCEPTION, changed);
          expect(outcome).toMatchObject({
            gate: { fail: false, matchingCount: 0 },
          });
          expect(json).toContain("[version 1.2.13] reviewed prebuilt binding");
        },
      );
    });

    it.each([
      ["metadata size", 256 * 1024 + 1, "small"],
      ["decoded content", 10, "large"],
    ])(
      "rejects a base config over 256 KiB by %s before analysis",
      async (_label, size, body) => {
        const runtime = withBaseConfig(CONFIG);
        const content = body === "large" ? "#".repeat(256 * 1024 + 1) : CONFIG;
        vi.mocked(runtime.contents.getContent).mockImplementation((request) =>
          Promise.resolve({
            status: 200,
            data: {
              type: "file",
              size:
                request.path === ".capdelta.yml"
                  ? size
                  : Buffer.byteLength(EMPTY_LOCKFILE),
              encoding: "base64",
              content: Buffer.from(
                request.path === ".capdelta.yml" ? content : EMPTY_LOCKFILE,
              ).toString("base64"),
            },
          }),
        );
        await expect(runAction(configured, context, runtime)).rejects.toThrow(
          "failed to read base config",
        );
        expect(runtime.analyze).not.toHaveBeenCalled();
      },
    );

    it("does not read policy on the unchanged-lockfile fast path", async () => {
      const runtime = withBaseConfig(CONFIG);
      vi.mocked(runtime.listChangedFiles).mockResolvedValue([".capdelta.yml"]);
      await expect(runAction(configured, context, runtime)).resolves.toEqual({
        status: "no-op",
      });
      expect(runtime.contents.getContent).not.toHaveBeenCalled();
    });
  });

  it("contextualizes artifact failures", async () => {
    const runtime = adapters();
    vi.mocked(runtime.uploadJson).mockRejectedValue(new Error("service down"));
    await expect(runAction(inputs, context, runtime)).rejects.toThrow(
      "failed to upload JSON report artifact",
    );
  });

  describe("intel-url", () => {
    function withChangedLockfiles(runtime: ReturnType<typeof adapters>) {
      runtime.contents.getContent.mockResolvedValue({
        status: 200,
        data: {
          type: "file",
          size: Buffer.byteLength(OLD_LOCKFILE),
          encoding: "base64",
          content: Buffer.from(OLD_LOCKFILE).toString("base64"),
        },
      });
      runtime.readHeadLockfile.mockResolvedValue(NEW_LOCKFILE);
      return runtime;
    }

    function intelFetch(verdict: string): typeof fetch {
      return (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (!url.startsWith("https://intel.example/")) {
          throw new Error(`unexpected fetch for ${url}`);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              findings: [
                {
                  id: INTEL_ID,
                  ecosystem: "npm",
                  name: "bad",
                  version: "1.1.0",
                  digest: "sha512-bad",
                  verdict,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      };
    }

    it("adds a confirmed feed match as CRITICAL and renders it in the comment", async () => {
      const runtime = withChangedLockfiles(
        adapters(emptyRun(), intelFetch("confirmed-malicious")),
      );

      const outcome = await runAction(
        { ...inputs, intelUrl: "https://intel.example" },
        context,
        runtime,
      );

      expect(outcome).toMatchObject({
        status: "analyzed",
        gate: { fail: true, highest: "CRITICAL" },
      });
      const json = runtime.uploadJson.mock.calls[0]?.[1];
      expect(json).toContain("intel-confirmed-malicious");
      expect(json).toContain(INTEL_ID);
      const body = runtime.comments.createComment.mock.calls[0]?.[0].body;
      expect(body).toContain("intel&#45;confirmed&#45;malicious");
      expect(body).toContain("CDI&#45;0123456789abcdef0123");
      expect(runtime.warn).not.toHaveBeenCalled();
    });

    it.each(["retracted", "suspected"])(
      "a %s verdict leaves the report and gate unchanged",
      async (verdict) => {
        const baseline = withChangedLockfiles(adapters());
        const baselineOutcome = await runAction(inputs, context, baseline);

        const withFeed = withChangedLockfiles(
          adapters(emptyRun(), intelFetch(verdict)),
        );
        const outcome = await runAction(
          { ...inputs, intelUrl: "https://intel.example" },
          context,
          withFeed,
        );

        expect(withFeed.uploadJson.mock.calls[0]?.[1]).toBe(
          baseline.uploadJson.mock.calls[0]?.[1],
        );
        expect(outcome.status === "analyzed" ? outcome.gate : null).toEqual(
          baselineOutcome.status === "analyzed" ? baselineOutcome.gate : null,
        );
        expect(withFeed.warn).not.toHaveBeenCalled();
      },
    );

    it("warns for an unreachable service and keeps local analysis", async () => {
      const baseline = withChangedLockfiles(adapters());
      const baselineOutcome = await runAction(inputs, context, baseline);

      const unreachable: typeof fetch = () =>
        Promise.reject(new TypeError("fetch failed"));
      const withFeed = withChangedLockfiles(adapters(emptyRun(), unreachable));
      const outcome = await runAction(
        { ...inputs, intelUrl: "https://intel.example" },
        context,
        withFeed,
      );

      expect(withFeed.uploadJson.mock.calls[0]?.[1]).toBe(
        baseline.uploadJson.mock.calls[0]?.[1],
      );
      expect(withFeed.warn).toHaveBeenCalledWith(
        "capdelta: intelligence service unavailable (network-error); continuing with local analysis only",
      );
      expect(outcome.status === "analyzed" ? outcome.gate : null).toEqual(
        baselineOutcome.status === "analyzed" ? baselineOutcome.gate : null,
      );
    });

    it("rejects an invalid service URL before analysis", async () => {
      const runtime = withChangedLockfiles(adapters());

      await expect(
        runAction(
          { ...inputs, intelUrl: "http://example.com" },
          context,
          runtime,
        ),
      ).rejects.toThrow("intel URL must use https");

      expect(runtime.listChangedFiles).not.toHaveBeenCalled();
      expect(runtime.analyze).not.toHaveBeenCalled();
    });
  });
});
