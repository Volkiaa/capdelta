/** Public library surface. Grows one component per milestone (PLAN §6). */
export {
  CapabilityDifferContractError,
  CapabilityDifferError,
  diffManifestCapabilities,
  type CapabilityChange,
  type CapabilityDiffDiagnostic,
  type CapabilityDiffResult,
  type CapabilityFinding,
  type FindingSeverity,
} from "./core/capability-differ.js";
export {
  CAPABILITY_SET_SCHEMA_VERSION,
  type AnalysisDiagnostic,
  type AnalysisDiagnosticKind,
  type Capability,
  type CapabilityLocation,
  type CapabilitySet,
  type CodeCapability,
  type CodeCapabilityKind,
  type CommandEntrypointCapability,
  type ContentDigest,
  type DependencyCapability,
  type Evidence,
  type EvidenceList,
  type InstallHook,
  type InstallHookCapability,
  type InstallScriptLocation,
  type PackageSubject,
  type RuntimeConstraintCapability,
} from "./core/contract/capability-set.js";
export type {
  ChangedPackage,
  LockfileDiffResult,
  LockfileFinding,
  LockfileFindingKind,
  SkipReason,
  SkippedPackage,
} from "./core/contract/lockfile-diff.js";
export { diffNpmLockfiles } from "./core/npm/lockfile-differ.js";
export {
  FetcherConfigurationError,
  FetcherContractError,
  FetcherError,
  MemoryTarballCache,
  fetchChangedPackages,
  type FetchFailure,
  type FetchFailureKind,
  type FetchPackageResult,
  type FetcherOptions,
  type TarballSide,
  type VerifiedTarball,
} from "./core/npm/fetcher.js";
export {
  ManifestCapabilityExtractorConfigurationError,
  ManifestCapabilityExtractorContractError,
  ManifestCapabilityExtractorError,
  extractNpmManifestCapabilities,
  type AnalyzedManifestCapabilities,
  type ManifestCapabilityExtractorOptions,
  type ManifestCapabilityFailure,
  type ManifestCapabilityFailureKind,
  type ManifestCapabilityResult,
  type UnavailableManifestCapabilities,
} from "./core/npm/manifest-capability-extractor.js";
export {
  ExtractorConfigurationError,
  ExtractorError,
  extractVerifiedTarball,
  type ExtractedTarball,
  type ExtractionFailure,
  type ExtractionFailureKind,
  type ExtractionResult,
  type ExtractorOptions,
  type RejectedExtraction,
} from "./core/npm/safe-extractor.js";
export {
  LockfileError,
  MalformedLockfileError,
  UnsupportedLockfileVersionError,
  type LockfileSide,
} from "./core/npm/errors.js";
