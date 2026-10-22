import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

// @types/node declares O_NOFOLLOW and O_NONBLOCK as numbers, but it leaves
// them undefined on Windows, so the casts keep both flags optional at runtime.
// O_NONBLOCK stops a FIFO swapped in after lstat from blocking open forever.
const OPEN_FLAGS =
  constants.O_RDONLY |
  ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
  ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);

// The cap is maxBytes + 1, so the chunk size only sets how often a read
// returns and the abort signal is checked.
const READ_CHUNK_BYTES = 64 * 1024;

export type ReadRegularFileResult =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "not-regular" }
  | { readonly kind: "too-large" };

export type ReadRegularFileOperation = "inspect" | "read";

type ReadContextError = Error & {
  operation: ReadRegularFileOperation;
  code?: string;
};

type ReadOutcome =
  | { readonly ok: true; readonly result: ReadRegularFileResult }
  | { readonly ok: false; readonly error: ReadContextError };

export function readRegularFileOperation(
  error: unknown,
): ReadRegularFileOperation | null {
  if (!(error instanceof Error)) return null;
  const operation = (error as { operation?: unknown }).operation;
  return operation === "inspect" || operation === "read" ? operation : null;
}

export async function readRegularFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ReadRegularFileResult> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw withPathContext(path, "inspect", error);
  }
  if (!metadata.isFile()) return { kind: "not-regular" };

  const handle = await openRegularCandidate(path);
  if (handle === null) return { kind: "not-regular" };

  let outcome: ReadOutcome;
  try {
    outcome = {
      ok: true,
      result: await readVerified(handle, metadata, maxBytes, signal),
    };
  } catch (error: unknown) {
    outcome = { ok: false, error: withPathContext(path, "read", error) };
  }
  const closeError = await closeHandle(handle, path);
  if (!outcome.ok) {
    // A failing close must not hide the read error, so keep both.
    if (closeError !== undefined) {
      throw new AggregateError(
        [outcome.error, closeError],
        `cannot read ${path}: the read and the close both failed`,
      );
    }
    throw outcome.error;
  }
  if (closeError !== undefined) throw closeError;
  return outcome.result;
}

async function readVerified(
  handle: FileHandle,
  expected: Stats,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<ReadRegularFileResult> {
  const opened = await handle.stat();
  if (
    !opened.isFile() ||
    opened.dev !== expected.dev ||
    opened.ino !== expected.ino
  ) {
    return { kind: "not-regular" };
  }
  if (opened.size > maxBytes) return { kind: "too-large" };

  const bytes = await readBounded(handle, opened.size, maxBytes, signal);
  if (bytes === null) return { kind: "too-large" };
  return { kind: "ok", bytes };
}

// Returns null once more than maxBytes have arrived. Bytes land in one buffer
// that starts at the stat size and doubles, capped at maxBytes + 1, so a file
// that grows after stat, even by tiny writes, cannot exhaust memory.
async function readBounded(
  handle: FileHandle,
  expectedBytes: number,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  const limit = maxBytes + 1;
  let buffer = Buffer.allocUnsafe(
    Math.min(Math.max(expectedBytes + 1, READ_CHUNK_BYTES), limit),
  );
  let total = 0;
  for (;;) {
    if (signal?.aborted === true) throw signal.reason;
    if (total === buffer.byteLength) {
      const grown = Buffer.allocUnsafe(Math.min(buffer.byteLength * 2, limit));
      buffer.copy(grown, 0, 0, total);
      buffer = grown;
    }
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.byteLength - total,
      null,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) return null;
  }
  return buffer.subarray(0, total);
}

async function openRegularCandidate(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, OPEN_FLAGS);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ELOOP")) return null;
    throw withPathContext(path, "read", error);
  }
}

async function closeHandle(
  handle: FileHandle,
  path: string,
): Promise<ReadContextError | undefined> {
  try {
    await handle.close();
    return undefined;
  } catch (error: unknown) {
    return withPathContext(path, "read", error);
  }
}

function withPathContext(
  path: string,
  operation: ReadRegularFileOperation,
  error: unknown,
): ReadContextError {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`cannot read ${path}: ${detail}`, {
    cause: error,
  }) as ReadContextError;
  wrapped.operation = operation;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      wrapped.code = code;
    }
  }
  return wrapped;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}
