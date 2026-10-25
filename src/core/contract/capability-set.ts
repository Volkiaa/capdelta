// PLAN §2, §4.3; ADR-004

export const CAPABILITY_SET_SCHEMA_VERSION = 1 as const;

export interface PackageSubject {
  /** Stable ecosystem identifier, for example "npm". */
  ecosystem: string;
  name: string;
  version: string;
}

export interface Evidence {
  /** POSIX-style path relative to the extracted package root. */
  file: string;
  /** One-based source line. */
  line: number;
  /**
   * Bounded raw source excerpt. This is attacker-controlled: every output
   * formatter must escape and may further truncate it (PLAN §3, §4.4).
   */
  snippet: string;
}

/** A capability without evidence is an assertion (PLAN §4.4). */
export type EvidenceList = readonly [Evidence, ...Evidence[]];

export type InstallHook = "preinstall" | "install" | "postinstall" | "prepare";

export interface InstallScriptLocation {
  kind: "install-script";
  hook: InstallHook;
  /** prepare runs on git installs, not registry installs (PLAN §4.3). */
  applicability: "registry-install" | "git-only";
}

export type CapabilityLocation =
  | InstallScriptLocation
  | { kind: "runtime" }
  | { kind: "manifest" }
  | { kind: "unknown" };

export interface ContentDigest {
  algorithm: "sha256";
  /** Lowercase hexadecimal digest. */
  value: string;
}

interface CapabilityBase {
  evidence: EvidenceList;
}

export interface InstallHookCapability extends CapabilityBase {
  kind: "INSTALL_HOOK";
  location: InstallScriptLocation;
  contentDigest: ContentDigest;
}

export interface CommandEntrypointCapability extends CapabilityBase {
  kind: "COMMAND_ENTRYPOINT";
  location: { kind: "runtime" };
  command: string;
  target: string;
}

export interface DependencyCapability extends CapabilityBase {
  kind: "DEPENDENCY";
  location: { kind: "manifest" };
  name: string;
  requirement: string;
  /** Alias-resolved package identity when it differs from the declared name. */
  targetName?: string;
}

export interface RuntimeConstraintCapability extends CapabilityBase {
  kind: "RUNTIME_CONSTRAINT";
  location: { kind: "manifest" };
  runtime: string;
  requirement: string;
}

/** PLAN §4.3 closed code-capability taxonomy, populated from M3 onward. */
export type CodeCapabilityKind =
  | "PROCESS"
  | "NET"
  | "FS_READ"
  | "FS_WRITE"
  | "FS_SENSITIVE"
  | "ENV"
  | "DYNAMIC_CODE"
  | "NATIVE"
  | "UNKNOWN";

export interface CodeCapability extends CapabilityBase {
  kind: CodeCapabilityKind;
  /** Install-script context is available before the AST layer needs it. */
  location: CapabilityLocation;
}

export type SignalParseState =
  "parsed" | "unparseable" | "unsupported" | "unreadable";

export type WalletAddressShape =
  "evm" | "tron" | "bitcoin-base58" | "bitcoin-bech32" | "solana";

/** ADR-044: address-shaped string literal, recorded from parsed content only. */
export interface SignalWalletAddressObservation {
  value: string;
  shape: WalletAddressShape;
  /** One-based source line of the literal. */
  line: number;
}

/** Per-file signal measurements; non-parsed states are first-class data. */
export interface SignalFileObservation {
  file: string;
  byteLength: number;
  entropyMilliBitsPerByte: number | null;
  parseState: SignalParseState;
  /** Line of a loop at module scope that has no exit condition. */
  topLevelLoop?: { line: number };
  /** ADR-044: the parsed file references a wallet provider. */
  walletProviderReference?: boolean;
  /** ADR-044: distinct address-shaped literals, capped at 32 per file. */
  walletAddresses?: readonly SignalWalletAddressObservation[];
}

export type SignalEndpointType = "domain" | "ipv4" | "ipv6";

/** Where the matched URL text sat in the source. */
export type SignalEndpointContext = "literal" | "embedded-text" | "unknown";

export interface SignalEndpointObservation {
  kind: "EXTERNAL_ENDPOINT";
  endpointType: SignalEndpointType;
  normalizedValue: string;
  confidence: "literal" | "byte-scan-candidate";
  context: SignalEndpointContext;
  /** ADR-037: "established" for main's rules, "additive" for a widened rule. */
  provenance: "established" | "additive";
  evidence: EvidenceList;
}

export type ObfuscationPattern = "hex-byte-array" | "charcode-array";

export interface SignalObfuscationObservation {
  kind: "OBFUSCATION_PATTERN";
  file: string;
  pattern: ObfuscationPattern;
  elementCount: number;
  evidence: EvidenceList;
}

export interface SignalSet {
  sourceFiles: readonly SignalFileObservation[];
  endpoints: readonly SignalEndpointObservation[];
  obfuscationPatterns: readonly SignalObfuscationObservation[];
}

export type Capability =
  | InstallHookCapability
  | CommandEntrypointCapability
  | DependencyCapability
  | RuntimeConstraintCapability
  | CodeCapability;

export type AnalysisDiagnosticKind =
  "malformed-manifest-field" | "unparseable-source" | "unsupported-source";

/** Loud partial-analysis datum; severity belongs to the later severity model. */
export interface AnalysisDiagnostic {
  kind: AnalysisDiagnosticKind;
  detail: string;
  evidence: EvidenceList;
}

export interface CapabilitySet {
  schemaVersion: typeof CAPABILITY_SET_SCHEMA_VERSION;
  subject: PackageSubject;
  /** partial requires at least one diagnostic; complete requires none. */
  completeness: "complete" | "partial";
  /** Deterministically sorted because this contract is serialized to JSON. */
  capabilities: readonly Capability[];
  diagnostics: readonly AnalysisDiagnostic[];
  /** Signal data is optional for compatibility; omission means an empty set. */
  signals?: SignalSet;
}
