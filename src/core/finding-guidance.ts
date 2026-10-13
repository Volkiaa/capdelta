/**
 * Reviewer guidance for findings (PLAN §4.5): why a change matters and what a
 * person should check. Every string is a constant authored here; package,
 * lockfile, and registry data is never interpolated into it. The wording
 * describes what code could do and always frames the change as something to
 * review. It never asserts malware or exploitation, and heuristic results are
 * stated as what static analysis found or suggests, not as fact.
 */
import type { ShapeRuleId, FindingSeverity } from "./capability-differ.js";
import type { Capability } from "./contract/capability-set.js";
import type { PackageAnalysisFailure } from "./capability-analysis-pipeline.js";
import type { JsonReportAnalysisIssue } from "./report-contract.js";
import type { SignalFindingKind } from "./signal-differ.js";
import {
  FETCH_STAGE_CRITICAL_KINDS,
  SeverityGateError,
  analysisIssueSeverity,
  isOperationalFailure,
  isUnanalyzableIssue,
} from "./run-severity.js";

export interface Guidance {
  /** One or two sentences on why the change matters to a reviewer. */
  whyItMatters: string;
  /** One sentence on what to check. */
  whatToCheck: string;
}

/** The capability kinds that carry guidance: manifest kinds plus code kinds. */
export type CapabilityGuidanceKind = Capability["kind"];

/**
 * The analysis-issue classes a reviewer needs guidance for. `integrity-mismatch`
 * and the lockfile/registry fetch failure are decided by the artifact or its
 * lockfile entry; `unanalyzable` is ADR-016; `operational` is ADR-018.
 */
export type AnalysisIssueClass =
  | "integrity-mismatch"
  | "lockfile-or-registry-fetch-failure"
  | "unanalyzable"
  | "operational";

/** Every PLAN §4.4 shape rule, so a new rule cannot ship without guidance. */
export const SHAPE_RULE_IDS: readonly ShapeRuleId[] = [
  "install-code-execution",
  "secret-exfiltration",
  "obfuscated-execution",
  "install-hook-change",
  "dynamic-or-native-code",
];

/** Every analysis-issue class, so a new class cannot ship without guidance. */
export const ANALYSIS_ISSUE_CLASSES: readonly AnalysisIssueClass[] = [
  "integrity-mismatch",
  "lockfile-or-registry-fetch-failure",
  "unanalyzable",
  "operational",
];

/** PLAN §4.5: only CRITICAL and HIGH changes carry reviewer guidance. */
export function guidanceWarranted(severity: FindingSeverity): boolean {
  return severity === "CRITICAL" || severity === "HIGH";
}

// PLAN §4.5 framing: describe what the code could do, never claim malware, and
// always ask the reviewer to review the change. Shared by the install-hook
// shape and the INSTALL_HOOK capability, which describe the same event.
const INSTALL_HOOK_GUIDANCE: Guidance = {
  whyItMatters:
    "Install hooks could run automatically during npm install, before any code imports the package, with the installing user's permissions, unless install scripts are disabled.",
  whatToCheck:
    "Check that the upstream repository and release notes explain the new hook.",
};

/**
 * One lookup per shape rule. Keyed by the ShapeRuleId union so a new rule fails
 * to compile until it has guidance.
 */
export const SHAPE_GUIDANCE: Readonly<Record<ShapeRuleId, Guidance>> = {
  "install-hook-change": INSTALL_HOOK_GUIDANCE,
  "install-code-execution": {
    whyItMatters:
      "This code runs at install time and could run commands, read environment secrets such as CI tokens and cloud keys, or contact the network.",
    whatToCheck:
      "Read the install-time file at the evidence line and confirm the behavior is expected.",
  },
  "secret-exfiltration": {
    whyItMatters:
      "Static analysis suggests the package reads secrets and has network access, which together could send credentials elsewhere.",
    whatToCheck: "Confirm what is read and where it is sent.",
  },
  "obfuscated-execution": {
    whyItMatters:
      "Static analysis found byte patterns consistent with obfuscation together with an execution primitive, which can obscure what the code does when it runs.",
    whatToCheck:
      "Open the file at the evidence line and confirm the encoding is expected.",
  },
  "dynamic-or-native-code": {
    whyItMatters:
      "Dynamic code evaluation and native binaries run behavior that static analysis cannot fully follow.",
    whatToCheck:
      "Confirm the package needs this and review the file at the evidence line.",
  },
};

/**
 * One lookup per capability kind, covering the four manifest kinds and every
 * CodeCapabilityKind. Keyed by the capability-kind union for exhaustiveness.
 */
export const CAPABILITY_GUIDANCE: Readonly<
  Record<CapabilityGuidanceKind, Guidance>
> = {
  INSTALL_HOOK: INSTALL_HOOK_GUIDANCE,
  COMMAND_ENTRYPOINT: {
    whyItMatters:
      "Registers a command that runs with the installing user's permissions whenever it is invoked.",
    whatToCheck: "Confirm the command and its target are expected.",
  },
  DEPENDENCY: {
    whyItMatters:
      "Pulls new code into the dependency tree, which then runs with the same access as the rest of the project.",
    whatToCheck:
      "Review the new dependency's own report and confirm it is expected.",
  },
  RUNTIME_CONSTRAINT: {
    whyItMatters:
      "Restricts the runtimes this package supports, which could drop a runtime you rely on.",
    whatToCheck: "Confirm the changed engine range is intentional.",
  },
  PROCESS: {
    whyItMatters:
      "Could start other programs on the machine, with the same permissions as the process running it.",
    whatToCheck:
      "Read the file at the evidence line and confirm the command is expected.",
  },
  NET: {
    whyItMatters:
      "Could contact a network host, which can send data out or fetch further code.",
    whatToCheck: "Confirm the destination and the data sent are expected.",
  },
  FS_READ: {
    whyItMatters:
      "Could read files from the machine running it, beyond the package itself.",
    whatToCheck: "Confirm the paths read are expected.",
  },
  FS_WRITE: {
    whyItMatters:
      "Could write or modify files on the machine running it, beyond the package itself.",
    whatToCheck: "Confirm the paths written are expected.",
  },
  FS_SENSITIVE: {
    whyItMatters:
      "Static analysis found reads or writes of credential locations such as ~/.npmrc, ~/.ssh or cloud configs.",
    whatToCheck: "Confirm the package needs that path.",
  },
  ENV: {
    whyItMatters:
      "Could read environment variables, which often hold CI tokens, cloud keys, and other secrets.",
    whatToCheck: "Confirm the variables read are expected.",
  },
  DYNAMIC_CODE: {
    whyItMatters:
      "Could build and run code from strings at runtime, so static analysis cannot see the full behavior.",
    whatToCheck:
      "Read the file at the evidence line and confirm the evaluated code is expected.",
  },
  NATIVE: {
    whyItMatters:
      "Ships or loads a native binary, which static JavaScript analysis cannot inspect.",
    whatToCheck:
      "Confirm the binary is expected and review its source or provenance.",
  },
  UNKNOWN: {
    whyItMatters:
      "capdelta could not classify this construct, so its behavior is unclear from the source alone.",
    whatToCheck:
      "Read the file at the evidence line and describe what it does.",
  },
};

/** One lookup per signal kind, keyed by the SignalFindingKind union. */
export const SIGNAL_GUIDANCE: Readonly<Record<SignalFindingKind, Guidance>> = {
  "new-external-endpoint": {
    whyItMatters:
      "The code now references a network host that was not present before, which could receive data.",
    whatToCheck:
      "Confirm the host is a known first-party or expected endpoint.",
  },
  "entropy-jump": {
    whyItMatters:
      "Static analysis found a file's byte pattern shifted toward high entropy, which can indicate packed or encrypted content.",
    whatToCheck:
      "Open the file at the evidence line and confirm the new content is expected.",
  },
  "unparseable-file": {
    whyItMatters:
      "capdelta cannot parse this file, so its behavior does not appear in the capability list.",
    whatToCheck: "Inspect the file manually or have it reviewed.",
  },
  "unparseable-bytes-growth": {
    whyItMatters:
      "The amount of code capdelta cannot parse grew, so more behavior is now out of view.",
    whatToCheck: "Inspect the new unparseable content manually.",
  },
  "obfuscation-pattern-added": {
    whyItMatters:
      "Static analysis found a byte-array or charcode pattern added, which can obscure what the code does.",
    whatToCheck:
      "Open the file at the evidence line and confirm the decoding is expected.",
  },
};

/**
 * One lookup per analysis-issue class, keyed by the AnalysisIssueClass union.
 * `analysisIssueClass` selects the class from the (stage, kind) pair.
 */
export const ANALYSIS_ISSUE_GUIDANCE: Readonly<
  Record<AnalysisIssueClass, Guidance>
> = {
  "integrity-mismatch": {
    whyItMatters: "The downloaded bytes differ from the lockfile hash.",
    whatToCheck:
      "Check where the lockfile entry and the registry response came from, and regenerate the lockfile from a trusted registry.",
  },
  "lockfile-or-registry-fetch-failure": {
    whyItMatters:
      "The lockfile entry or the registry response could not be turned into a verified artifact, so capdelta did not inspect it.",
    whatToCheck:
      "Fix the lockfile entry or the registry source; for a download-size limit, use a smaller artifact or have the cap raised in capdelta. A reviewed exception cannot cover this failure.",
  },
  unanalyzable: {
    whyItMatters:
      "capdelta could not inspect this artifact, so anything in it is unreviewed.",
    whatToCheck:
      "Inspect the artifact manually, or add a reviewed exception bound to these bytes (ADR-017).",
  },
  operational: {
    whyItMatters:
      "capdelta did not complete the analysis of this package, so the run fails.",
    whatToCheck:
      "Re-run the analysis, and check the environment and budget settings if it recurs.",
  },
};

export function shapeGuidance(ruleId: ShapeRuleId): Guidance {
  return SHAPE_GUIDANCE[ruleId];
}

export function capabilityGuidance(kind: CapabilityGuidanceKind): Guidance {
  return CAPABILITY_GUIDANCE[kind];
}

export function signalGuidance(kind: SignalFindingKind): Guidance {
  return SIGNAL_GUIDANCE[kind];
}

/**
 * `isOperationalFailure` classifies the pipeline's discriminated failure, but
 * the JSON report keeps `stage` and `kind` in separate fields. Rebuild the
 * minimal pair the predicate inspects (`stage` plus `failure.kind`) so guidance
 * reuses the gate's decision instead of copying its switch.
 */
function operationalProbe(
  issue: Pick<JsonReportAnalysisIssue, "stage" | "kind">,
): PackageAnalysisFailure {
  return {
    stage: issue.stage,
    failure: { kind: issue.kind },
  } as PackageAnalysisFailure;
}

/**
 * Classify one analysis issue with the same helpers the gate uses, so guidance
 * can never disagree with severity. Returns `null` for a severity-null issue
 * that is not an operational failure: it carries no guidance, and every caller
 * must handle the `null` explicitly. The helpers are exhaustive over the
 * correlated (stage, kind) union and throw for a pair the pipeline cannot
 * produce, so an unknown kind can never fall through silently.
 */
export function analysisIssueClass(
  issue: Pick<JsonReportAnalysisIssue, "stage" | "kind">,
): AnalysisIssueClass | null {
  if (issue.kind === "integrity-mismatch") return "integrity-mismatch";
  // ADR-017 amendment A: every other kind in FETCH_STAGE_CRITICAL_KINDS
  // (run-severity.ts:79) is decided before or without byte verification, so a
  // reviewed exception can never cover it. They are lockfile/registry fetch
  // failures, distinct from an artifact we verified but could not parse. The
  // gate's own list decides the set; no fetch kind is hand-written here.
  if (
    issue.stage === "fetch" &&
    (FETCH_STAGE_CRITICAL_KINDS as readonly string[]).includes(issue.kind)
  ) {
    return "lockfile-or-registry-fetch-failure";
  }
  if (isUnanalyzableIssue(issue)) return "unanalyzable";
  // ADR-018: operational if and only if the gate's own predicate says so.
  if (isOperationalFailure(operationalProbe(issue))) return "operational";
  if (analysisIssueSeverity(issue) === null) return null;
  throw new SeverityGateError(
    `no guidance class for analysis issue ${issue.stage}/${issue.kind}`,
  );
}

/**
 * Guidance for one analysis issue, or `null` when `analysisIssueClass` returns
 * `null` (a severity-null, non-operational issue). Callers handle `null`.
 */
export function analysisIssueGuidance(
  issue: Pick<JsonReportAnalysisIssue, "stage" | "kind">,
): Guidance | null {
  const issueClass = analysisIssueClass(issue);
  return issueClass === null ? null : ANALYSIS_ISSUE_GUIDANCE[issueClass];
}
