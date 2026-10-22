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

  const bytes = await readBounded(handle, maxBytes, signal);
  if (bytes === null) return { kind: "too-large" };
  return { kind: "ok", bytes };
}

// Returns null once more than maxBytes have arrived. Every allocation is at
// most maxBytes + 1 bytes, so a file that grows after stat cannot exhaust
// memory.
async function readBounded(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted === true) throw signal.reason;
    const capacity = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, capacity));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) return null;
  }
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];
  return Buffer.concat(chunks, total);
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
