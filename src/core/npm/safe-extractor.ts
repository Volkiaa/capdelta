import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import * as tar from "tar";
import type { ReadEntry } from "tar";
import {
  analysisStopDetail,
  analysisStopKind,
  type AnalysisStopKind,
} from "../analysis-execution-policy.js";
import { NamedError } from "../named-error.js";
import { errorName } from "../guards.js";
import type { VerifiedTarball } from "./fetcher.js";

export type ExtractionFailureKind =
  | "invalid-archive"
  | "invalid-layout"
  | "unsafe-path"
  | "link-entry"
  | "unsupported-entry"
  | "file-count-limit"
  | "expanded-size-limit"
  | "decompression-ratio-limit"
  | "filesystem-error"
  | AnalysisStopKind;

export interface ExtractionFailure {
  kind: ExtractionFailureKind;
  detail: string;
}

export interface ExtractedTarball {
  status: "extracted";
  /**
   * Fresh, private directory holding the package as npm installs it: every
   * entry with its first path component stripped (ADR-013).
   */
  root: string;
  fileCount: number;
  expandedBytes: number;
  /** Removes the private extraction root once the next component is finished. */
  cleanup(): Promise<void>;
}

export interface RejectedExtraction {
  status: "rejected";
  failure: ExtractionFailure;
}

export type ExtractionResult = ExtractedTarball | RejectedExtraction;

export interface ExtractorOptions {
  /** Maximum regular files and directories accepted from one tarball. */
  maxFileCount?: number;
  /** Maximum sum of regular-file sizes after decompression. */
  maxExpandedBytes?: number;
  /** Maximum decompressed-to-compressed ratio accepted by node-tar. */
  maxDecompressionRatio?: number;
  /** Whole-analysis cooperative cancellation. */
  signal?: AbortSignal;
}

export class ExtractorError extends NamedError {}

/** Invalid caller configuration: the extractor cannot safely weaken its caps. */
export class ExtractorConfigurationError extends ExtractorError {}

interface ResolvedOptions {
  maxFileCount: number;
  maxExpandedBytes: number;
  maxDecompressionRatio: number;
  signal?: AbortSignal;
}

interface ArchiveSummary {
  fileCount: number;
  expandedBytes: number;
}

const DEFAULT_MAX_FILE_COUNT = 10_000;
const DEFAULT_MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const DEFAULT_MAX_DECOMPRESSION_RATIO = 100;
const MAX_META_ENTRY_BYTES = 64 * 1024;
const ALLOWED_ENTRY_TYPES = new Set(["File", "OldFile", "Directory"]);

/** A deliberate rejection caused by attacker-controlled archive contents. */
class ArchiveRejectedError extends NamedError {
  constructor(
    readonly kind: Exclude<
      ExtractionFailureKind,
      | "invalid-archive"
      | "filesystem-error"
      | "analysis-aborted"
      | "deadline-exceeded"
    >,
    message: string,
  ) {
    super(message);
  }
}

class ExtractionStoppedError extends NamedError {
  readonly kind: AnalysisStopKind;

  constructor(signal: AbortSignal) {
    super(analysisStopDetail(signal));
    this.kind = analysisStopKind(signal) ?? "analysis-aborted";
  }
}

/**
 * Safely extracts a Fetcher-verified npm tarball. No archive entry is written
 * until preflight validates every path, type, count, and expanded-size limit.
 * The verified archive is first written as opaque data under a fresh private
 * temp root; no archive entry is extracted until preflight completes. It never
 * imports or executes extracted package code (PLAN §3, §4.2).
 */
export async function extractVerifiedTarball(
  tarball: VerifiedTarball,
  options: ExtractorOptions = {},
): Promise<ExtractionResult> {
  return extractVerifiedTarballInternal(tarball, options, false);
}

/**
 * Validates an archive exactly like full extraction but writes only the npm
 * manifest. The pipeline uses this bounded preflight to discover install
 * hooks before scheduling the expensive full extraction/AST phase.
 */
export async function extractVerifiedManifest(
  tarball: VerifiedTarball,
  options: ExtractorOptions = {},
): Promise<ExtractionResult> {
  return extractVerifiedTarballInternal(tarball, options, true);
}

async function extractVerifiedTarballInternal(
  tarball: VerifiedTarball,
  options: ExtractorOptions,
  manifestOnly: boolean,
): Promise<ExtractionResult> {
  const resolved = resolveOptions(options);
  let workRoot: string | undefined;
  try {
    throwIfStopped(resolved.signal);
    workRoot = await mkdtemp(join(tmpdir(), "capdelta-"));
    const privateWorkRoot = workRoot;
    // The tar package warns that extraction roots must not be attacker
    // controlled. mkdtemp gives us a unique root; 0700 keeps it private.
    await chmod(privateWorkRoot, 0o700);
    throwIfStopped(resolved.signal);
    const archivePath = join(privateWorkRoot, "verified-package.tgz");
    const extractionRoot = join(privateWorkRoot, "package");
    await writeFile(archivePath, tarball.bytes, {
      flag: "wx",
      mode: 0o600,
      ...(resolved.signal === undefined ? {} : { signal: resolved.signal }),
    });
    const summary = await preflight(archivePath, resolved);
    throwIfStopped(resolved.signal);
    await mkdir(extractionRoot, { mode: 0o700 });
    await extract(archivePath, extractionRoot, resolved, manifestOnly);
    throwIfStopped(resolved.signal);
    await unlink(archivePath);
    return {
      status: "extracted",
      root: extractionRoot,
      fileCount: summary.fileCount,
      expandedBytes: summary.expandedBytes,
      cleanup: async () => removeRoot(privateWorkRoot),
    };
  } catch (error: unknown) {
    if (workRoot !== undefined) {
      try {
        await removeRoot(workRoot);
      } catch (cleanupError: unknown) {
        return {
          status: "rejected",
          failure: {
            kind: "filesystem-error",
            detail: `extraction failed and cleanup failed: ${errorName(error)}, ${errorName(cleanupError)}`,
          },
        };
      }
    }
    return {
      status: "rejected",
      failure:
        resolved.signal?.aborted === true
          ? {
              kind: analysisStopKind(resolved.signal) ?? "analysis-aborted",
              detail: analysisStopDetail(resolved.signal),
            }
          : classifyFailure(error),
    };
  }
}

async function preflight(
  archivePath: string,
  options: ResolvedOptions,
): Promise<ArchiveSummary> {
  throwIfStopped(options.signal);
  let fileCount = 0;
  let expandedBytes = 0;
  let installedFiles = 0;
  await tar.t({
    file: archivePath,
    strict: true,
    gzip: true,
    maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    maxDecompressionRatio: options.maxDecompressionRatio,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    filter(this: tar.Parser, _path, rawEntry) {
      if (options.signal?.aborted === true) {
        this.abort(new ExtractionStoppedError(options.signal));
        return false;
      }
      const entry = rawEntry as ReadEntry;
      if (entry.meta) return true;
      try {
        // Directory headers are validated and counted but never installed.
        if (
          validateArchiveEntry(entry) !== null &&
          entry.type !== "Directory"
        ) {
          installedFiles += 1;
        }
        fileCount += 1;
        if (fileCount > options.maxFileCount) {
          this.abort(
            new ArchiveRejectedError(
              "file-count-limit",
              `archive exceeds ${String(options.maxFileCount)} entries`,
            ),
          );
          return false;
        }
        if (entry.type !== "Directory") {
          expandedBytes += entry.size;
          if (expandedBytes > options.maxExpandedBytes) {
            this.abort(
              new ArchiveRejectedError(
                "expanded-size-limit",
                `archive expands beyond ${String(options.maxExpandedBytes)} bytes`,
              ),
            );
            return false;
          }
        }
      } catch (error: unknown) {
        if (error instanceof ArchiveRejectedError) {
          this.abort(error);
          return false;
        }
        throw error;
      }
      return true;
    },
  });
  throwIfStopped(options.signal);
  if (installedFiles === 0) {
    // Only bare roots, directory headers, or top-level files npm drops:
    // nothing of the package would be installed, so nothing to analyze.
    throw new ArchiveRejectedError(
      "invalid-layout",
      "archive has no files beneath a top-level directory",
    );
  }
  return { fileCount, expandedBytes };
}

async function extract(
  archivePath: string,
  root: string,
  options: ResolvedOptions,
  manifestOnly: boolean,
): Promise<void> {
  throwIfStopped(options.signal);
  await tar.x({
    file: archivePath,
    cwd: root,
    strict: true,
    gzip: true,
    // npm (pacote) strips exactly one leading component from every entry,
    // whatever its name (ADR-013). Preflight already validated every
    // remaining component, so strip cannot relocate a path outside root.
    strip: 1,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    chmod: false,
    unlink: true,
    maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    maxDecompressionRatio: options.maxDecompressionRatio,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    filter(this: tar.Parser, path, rawEntry) {
      if (options.signal?.aborted === true) {
        this.abort(new ExtractionStoppedError(options.signal));
        return false;
      }
      const entry = rawEntry as ReadEntry;
      // Same mapping as preflight. Like pacote, never write Directory
      // headers: a later "b/index.js/" header must not replace an installed
      // index.js file. node-tar creates parent directories for files. A
      // manifest-only pass keeps every root's package.json in archive order,
      // so the last one wins exactly as in a full extraction.
      if (entry.type === "Directory") return false;
      const effective = effectivePath(path, entry.type);
      if (effective === null) return false;
      if (manifestOnly && effective !== "package.json") return false;
      // ADR-019: node-tar creates each file with the archive entry's mode
      // (node_modules/tar/dist/esm/unpack.js:401 reads entry.mode at write
      // time), so a mode-000 file would be unreadable on an unprivileged
      // runner and could hide an install hook from analysis. Normalize every
      // written file to 0o600, the same mechanism pacote uses in its filter
      // (npm/pacote lib/fetcher.js, #entryMode). capdelta never executes
      // package code, so no execute bit is needed, and setuid/setgid/sticky
      // bits never reach disk.
      entry.mode = 0o600;
      return true;
    },
  });
  throwIfStopped(options.signal);
}

function validateArchiveEntry(entry: ReadEntry): string | null {
  if (!ALLOWED_ENTRY_TYPES.has(entry.type)) {
    if (entry.type === "Link" || entry.type === "SymbolicLink") {
      throw new ArchiveRejectedError(
        "link-entry",
        `archive contains ${entry.type}`,
      );
    }
    throw new ArchiveRejectedError(
      "unsupported-entry",
      `archive contains unsupported ${entry.type} entry`,
    );
  }
  return effectivePath(entry.path, entry.type);
}

/**
 * Validates every component of a raw archive path, then applies npm's
 * strip-one mapping. Only a Directory entry may end in a single "/".
 */
function effectivePath(rawPath: string, type: string): string | null {
  if (
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    isAbsolute(rawPath) ||
    posix.isAbsolute(rawPath) ||
    win32.isAbsolute(rawPath)
  ) {
    throw new ArchiveRejectedError(
      "unsafe-path",
      "archive entry has an absolute or unsafe path",
    );
  }
  const path =
    type === "Directory" && rawPath.endsWith("/")
      ? rawPath.slice(0, -1)
      : rawPath;
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new ArchiveRejectedError(
      "unsafe-path",
      "archive entry has empty, dot, or parent path segment",
    );
  }
  // A bare root directory or a top-level file has no installed path.
  if (segments.length === 1) return null;
  const effective = segments.slice(1).join("/");
  // Stripping the root must not expose an absolute or drive-qualified path
  // (x/C:/package.json becomes C:/package.json). Reject it, stricter than
  // pacote's normalization.
  if (
    posix.isAbsolute(effective) ||
    win32.isAbsolute(effective) ||
    /^[A-Za-z]:/u.test(effective)
  ) {
    throw new ArchiveRejectedError(
      "unsafe-path",
      "archive entry exposes an absolute path after its root is stripped",
    );
  }
  return effective;
}

function resolveOptions(options: ExtractorOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    maxFileCount: options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT,
    maxExpandedBytes: options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES,
    maxDecompressionRatio:
      options.maxDecompressionRatio ?? DEFAULT_MAX_DECOMPRESSION_RATIO,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  for (const [name, value] of [
    ["maxFileCount", resolved.maxFileCount],
    ["maxExpandedBytes", resolved.maxExpandedBytes],
    ["maxDecompressionRatio", resolved.maxDecompressionRatio],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ExtractorConfigurationError(
        `${name} must be a positive safe integer`,
      );
    }
  }
  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new ExtractorConfigurationError("signal must implement AbortSignal");
  }
  return resolved;
}

function classifyFailure(error: unknown): ExtractionFailure {
  if (error instanceof ExtractionStoppedError) {
    return { kind: error.kind, detail: error.message };
  }
  if (error instanceof ArchiveRejectedError) {
    return { kind: error.kind, detail: error.message };
  }
  if (isDecompressionRatioError(error)) {
    return {
      kind: "decompression-ratio-limit",
      detail: "archive exceeds the configured decompression ratio",
    };
  }
  return {
    kind: "invalid-archive",
    detail: `tar archive could not be processed: ${errorName(error)}`,
  };
}

function throwIfStopped(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ExtractionStoppedError(signal);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof value.aborted === "boolean" &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function"
  );
}

function isDecompressionRatioError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === "TAR_ABORT"
  );
}

async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 2 });
}
