import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegularFile } from "./read-regular-file.js";

async function withDirectory<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "capdelta-read-regular-file-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("readRegularFile", () => {
  it("reads the bytes of a regular file", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "fixture.txt");
      await writeFile(path, "inert fixture\n", "utf8");

      const result = await readRegularFile(path, 1024);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected a read");
      expect(result.bytes.toString("utf8")).toBe("inert fixture\n");
    });
  });

  it.skipIf(process.platform === "win32")(
    "treats a symlink to a regular file as not-regular",
    async () => {
      await withDirectory(async (root) => {
        const target = join(root, "target.txt");
        const link = join(root, "link.txt");
        await writeFile(target, "inert fixture\n", "utf8");
        await symlink(target, link);

        expect(await readRegularFile(link, 1024)).toEqual({
          kind: "not-regular",
        });
      });
    },
  );

  it("treats a directory as not-regular", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "directory");
      await mkdir(path);

      expect(await readRegularFile(path, 1024)).toEqual({
        kind: "not-regular",
      });
    });
  });

  it("reports a file over maxBytes as too-large", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "fixture.txt");
      await writeFile(path, "inert fixture\n", "utf8");

      expect(await readRegularFile(path, 8)).toEqual({ kind: "too-large" });
    });
  });

  it("rethrows a missing path with the path in the message", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "missing.txt");

      const error = await readRegularFile(path, 1024).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected an error");
      expect(error.message).toContain(path);
      expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  it.skipIf(process.platform === "win32")(
    "treats a FIFO as not-regular without hanging",
    async () => {
      await withDirectory(async (root) => {
        const path = join(root, "fifo");
        execFileSync("mkfifo", [path]);

        expect(await readRegularFile(path, 1024)).toEqual({
          kind: "not-regular",
        });
      });
    },
  );

  it("reads a file of exactly maxBytes", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "fixture.bin");
      await writeFile(path, Buffer.alloc(16, 0x61));

      const result = await readRegularFile(path, 16);

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("expected a read");
      expect(result.bytes.byteLength).toBe(16);
    });
  });

  it("reports a file of maxBytes + 1 bytes as too-large", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "fixture.bin");
      await writeFile(path, Buffer.alloc(17, 0x61));

      expect(await readRegularFile(path, 16)).toEqual({ kind: "too-large" });
    });
  });

  it("rejects with the abort reason as the cause when the signal is already aborted", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "fixture.txt");
      await writeFile(path, "inert fixture\n", "utf8");
      const controller = new AbortController();
      controller.abort();

      const error = await readRegularFile(path, 1024, controller.signal).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected an error");
      expect(error.cause).toBe(controller.signal.reason);
    });
  });

  it("records an lstat failure as an inspect operation", async () => {
    await withDirectory(async (root) => {
      const path = join(root, "missing.txt");

      const error = await readRegularFile(path, 1024).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("expected an error");
      expect((error as { operation?: unknown }).operation).toBe("inspect");
    });
  });
});
