/** Public library surface. Grows one component per milestone (PLAN §6). */
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
  LockfileError,
  MalformedLockfileError,
  UnsupportedLockfileVersionError,
  type LockfileSide,
} from "./core/npm/errors.js";
