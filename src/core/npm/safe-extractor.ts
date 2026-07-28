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
  /** Fresh, private directory containing the contents beneath npm's package/. */
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

export class ExtractorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

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
const PACKAGE_ROOT = "package";
const ALLOWED_ENTRY_TYPES = new Set(["File", "OldFile", "Directory"]);

/** A deliberate rejection caused by attacker-controlled archive contents. */
class ArchiveRejectedError extends Error {
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
    this.name = new.target.name;
  }
}

class ExtractionStoppedError extends Error {
  readonly kind: AnalysisStopKind;

  constructor(signal: AbortSignal) {
    super(analysisStopDetail(signal));
    this.name = new.target.name;
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
    await extract(archivePath, extractionRoot, resolved);
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
    return { status: "rejected", failure: classifyFailure(error) };
  }
}

async function preflight(
  archivePath: string,
  options: ResolvedOptions,
): Promise<ArchiveSummary> {
  throwIfStopped(options.signal);
  let fileCount = 0;
  let expandedBytes = 0;
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
        validateArchiveEntry(entry);
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
  return { fileCount, expandedBytes };
}

async function extract(
  archivePath: string,
  root: string,
  options: ResolvedOptions,
): Promise<void> {
  throwIfStopped(options.signal);
  await tar.x({
    file: archivePath,
    cwd: root,
    strict: true,
    gzip: true,
    // The npm registry tarball layout is package/<contents>. Requiring it in
    // preflight means strip: 1 cannot relocate a malicious path unexpectedly.
    strip: 1,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    chmod: false,
    unlink: true,
    maxMetaEntrySize: MAX_META_ENTRY_BYTES,
    maxDecompressionRatio: options.maxDecompressionRatio,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    filter(this: tar.Parser) {
      if (options.signal?.aborted !== true) return true;
      this.abort(new ExtractionStoppedError(options.signal));
      return false;
    },
  });
  throwIfStopped(options.signal);
}

function validateArchiveEntry(entry: ReadEntry): void {
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
  validatePackagePath(entry.path);
}

function validatePackagePath(rawPath: string): void {
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
  const segments = rawPath.split("/");
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
  if (segments[0] !== PACKAGE_ROOT) {
    throw new ArchiveRejectedError(
      "invalid-layout",
      "npm tarball entries must be rooted beneath package/",
    );
  }
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
