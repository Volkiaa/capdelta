import { describe, expect, it } from "vitest";
import type {
  AnalysisDiagnostic,
  Capability,
  CapabilitySet,
  CommandEntrypointCapability,
  DependencyCapability,
  InstallHook,
  InstallHookCapability,
  PackageSubject,
  RuntimeConstraintCapability,
} from "./contract/capability-set.js";
import {
  CapabilityDifferContractError,
  diffManifestCapabilities,
} from "./capability-differ.js";

const SUBJECT: PackageSubject = {
  ecosystem: "npm",
  name: "fixture",
  version: "2.0.0",
};

const EVIDENCE = [
  { file: "package.json", line: 2, snippet: '"fixture": "value"' },
] as const;

function installHook(hook: InstallHook, digest: string): InstallHookCapability {
  return {
    kind: "INSTALL_HOOK",
    location: {
      kind: "install-script",
      hook,
      applicability: hook === "prepare" ? "git-only" : "registry-install",
    },
    contentDigest: { algorithm: "sha256", value: digest },
    evidence: EVIDENCE,
  };
}

function command(name: string, target: string): CommandEntrypointCapability {
  return {
    kind: "COMMAND_ENTRYPOINT",
    location: { kind: "runtime" },
    command: name,
    target,
    evidence: EVIDENCE,
  };
}

function dependency(name: string, requirement: string): DependencyCapability {
  return {
    kind: "DEPENDENCY",
    location: { kind: "manifest" },
    name,
    requirement,
    evidence: EVIDENCE,
  };
}

function runtime(
  name: string,
  requirement: string,
): RuntimeConstraintCapability {
  return {
    kind: "RUNTIME_CONSTRAINT",
    location: { kind: "manifest" },
    runtime: name,
    requirement,
    evidence: EVIDENCE,
  };
}

function set(
  version: string,
  capabilities: readonly Capability[],
  diagnostics: readonly AnalysisDiagnostic[] = [],
): CapabilitySet {
  return {
    schemaVersion: 1,
    subject: { ...SUBJECT, version },
    completeness: diagnostics.length === 0 ? "complete" : "partial",
    capabilities,
    diagnostics,
  };
}

function partialSetWithoutDiagnostics(): CapabilitySet {
  return { ...set("2.0.0", []), completeness: "partial" };
}

describe("diffManifestCapabilities", () => {
  it("reports manifest additions and meaningful changes in severity-first order", () => {
    const oldHook = installHook("postinstall", "old");
    const oldCommand = command("fixture", "old.js");
    const oldRuntime = runtime("node", ">=18");
    const old = set("1.0.0", [
      oldHook,
      oldCommand,
      dependency("kept", "^1.0.0"),
      dependency("removed", "^1.0.0"),
      oldRuntime,
    ]);
    const newest = set("2.0.0", [
      installHook("postinstall", "new"),
      installHook("prepare", "prepare"),
      command("fixture", "new.js"),
      dependency("kept", "^2.0.0"),
      dependency("added", "^1.0.0"),
      runtime("node", ">=20"),
    ]);

    const result = diffManifestCapabilities(old, newest);

    expect(result.newPackage).toBe(false);
    expect(
      result.findings.map((finding) => [
        finding.severity,
        finding.change,
        finding.capability.kind,
      ]),
    ).toEqual([
      ["CRITICAL", "changed", "INSTALL_HOOK"],
      ["LOW", "changed", "COMMAND_ENTRYPOINT"],
      ["LOW", "added", "DEPENDENCY"],
      ["INFO", "added", "INSTALL_HOOK"],
      ["INFO", "changed", "RUNTIME_CONSTRAINT"],
    ]);
    expect(result.findings[0]?.previous).toBe(oldHook);
    expect(result.findings[1]?.previous).toBe(oldCommand);
    expect(result.findings[4]?.previous).toBe(oldRuntime);
    expect(result.findings[2]?.previous).toBeNull();
    expect(result.diagnostics).toEqual([]);
  });

  it("ignores removals and dependency requirement-only changes", () => {
    const old = set("1.0.0", [
      dependency("removed", "1"),
      dependency("kept", "1"),
    ]);
    const newest = set("2.0.0", [dependency("kept", "2")]);

    expect(diffManifestCapabilities(old, newest).findings).toEqual([]);
  });

  it("emits a full manifest report for a newly added package", () => {
    const newest = set("2.0.0", [
      runtime("node", ">=20"),
      dependency("dep", "1"),
      command("fixture", "bin.js"),
      installHook("prepare", "prepare"),
      installHook("install", "install"),
    ]);

    const result = diffManifestCapabilities(null, newest);

    expect(result.newPackage).toBe(true);
    expect(result.findings).toHaveLength(5);
    expect(result.findings.every((finding) => finding.change === "added")).toBe(
      true,
    );
    expect(result.findings.every((finding) => finding.previous === null)).toBe(
      true,
    );
    expect(result.findings.map((finding) => finding.severity)).toEqual([
      "CRITICAL",
      "LOW",
      "LOW",
      "INFO",
      "INFO",
    ]);
  });

  it("propagates partial-analysis diagnostics with their source side", () => {
    const oldDiagnostic: AnalysisDiagnostic = {
      kind: "malformed-manifest-field",
      detail: "old detail",
      evidence: [{ file: "package.json", line: 4, snippet: "old" }],
    };
    const newDiagnostic: AnalysisDiagnostic = {
      kind: "malformed-manifest-field",
      detail: "new detail",
      evidence: [{ file: "package.json", line: 2, snippet: "new" }],
    };

    const result = diffManifestCapabilities(
      set("1.0.0", [], [oldDiagnostic]),
      set("2.0.0", [], [newDiagnostic]),
    );

    expect(result.diagnostics).toEqual([
      { side: "old", diagnostic: oldDiagnostic },
      { side: "new", diagnostic: newDiagnostic },
    ]);
  });

  it("throws when old and new sets describe different packages", () => {
    const old = set("1.0.0", []);
    const newest = {
      ...set("2.0.0", []),
      subject: { ...SUBJECT, name: "other" },
    };

    expect(() => diffManifestCapabilities(old, newest)).toThrow(
      CapabilityDifferContractError,
    );
  });

  it.each([
    [
      "unsupported schema",
      { ...set("2.0.0", []), schemaVersion: 2 } as unknown as CapabilitySet,
    ],
    [
      "duplicate semantic slots",
      set("2.0.0", [dependency("same", "1"), dependency("same", "2")]),
    ],
    [
      "future code capability",
      set("2.0.0", [
        {
          kind: "NET",
          location: { kind: "runtime" },
          evidence: EVIDENCE,
        },
      ]),
    ],
    ["invalid completeness invariant", partialSetWithoutDiagnostics()],
  ])("throws for %s", (_label, malformed) => {
    expect(() => diffManifestCapabilities(null, malformed)).toThrow(
      CapabilityDifferContractError,
    );
  });
});
