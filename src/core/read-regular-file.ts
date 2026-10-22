import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

// @types/node declares O_NOFOLLOW as a number, but it is undefined on Windows.
const OPEN_FLAGS =
  constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

export type ReadRegularFileResult =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "not-regular" }
  | { readonly kind: "too-large" };

export async function readRegularFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ReadRegularFileResult> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    throw withPathContext(path, error);
  }
  if (!metadata.isFile()) return { kind: "not-regular" };

  const handle = await openRegularCandidate(path);
  if (handle === null) return { kind: "not-regular" };
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) {
      return { kind: "not-regular" };
    }
    if (opened.size > maxBytes) return { kind: "too-large" };

    const bytes = await handle.readFile(
      signal === undefined ? undefined : { signal },
    );
    if (bytes.byteLength > maxBytes) return { kind: "too-large" };
    return { kind: "ok", bytes };
  } catch (error: unknown) {
    throw withPathContext(path, error);
  } finally {
    await closeHandle(handle, path);
  }
}

async function openRegularCandidate(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, OPEN_FLAGS);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ELOOP")) return null;
    throw withPathContext(path, error);
  }
}

async function closeHandle(handle: FileHandle, path: string): Promise<void> {
  try {
    await handle.close();
  } catch (error: unknown) {
    throw withPathContext(path, error);
  }
}

function withPathContext(path: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`cannot read ${path}: ${detail}`, { cause: error });
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      (wrapped as NodeJS.ErrnoException).code = code;
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
