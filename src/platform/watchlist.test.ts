import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWatchlist, readWatchlist, WatchlistError } from "./watchlist.js";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-watchlist-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("parseWatchlist", () => {
  it("ranks packages in line order and ignores comments and blank lines", () => {
    const list = parseWatchlist(
      "# npm high impact\nalpha\n\n# a scoped package\n@scope/beta\ncharlie\n",
    );

    expect([...list]).toEqual([
      ["alpha", 0],
      ["@scope/beta", 1],
      ["charlie", 2],
    ]);
  });

  it("accepts Windows line endings without ranking the carriage return", () => {
    const list = parseWatchlist("alpha\r\nbeta\r\n");

    expect([...list]).toEqual([
      ["alpha", 0],
      ["beta", 1],
    ]);
  });

  it("rejects a duplicate name at the line it repeats on", () => {
    const parse = (): ReadonlyMap<string, number> =>
      parseWatchlist("alpha\nbeta\nalpha\n");

    expect(parse).toThrow(WatchlistError);
    expect(parse).toThrow(/line 3/u);
    expect(parse).toThrow(/duplicate/u);
  });

  it("rejects an invalid package name with its line number", () => {
    const parse = (): ReadonlyMap<string, number> =>
      parseWatchlist("alpha\nbad name\n");

    expect(parse).toThrow(WatchlistError);
    expect(parse).toThrow(/line 2/u);
    expect(parse).toThrow(/whitespace/u);
  });

  it("rejects an empty list", () => {
    expect(() => parseWatchlist("# only comments\n\n")).toThrow(WatchlistError);
    expect(() => parseWatchlist("")).toThrow(/empty/u);
  });

  it("rejects a list over 100000 lines and names the first line over", () => {
    const lines = Array.from(
      { length: 100_001 },
      (_, index) => `p${String(index)}`,
    );

    const parse = (): ReadonlyMap<string, number> =>
      parseWatchlist(lines.join("\n"));

    expect(parse).toThrow(WatchlistError);
    expect(parse).toThrow(/line 100001/u);
    expect(parse).toThrow(/100000/u);
  });

  it("accepts 100000 names with a trailing newline", () => {
    const lines = Array.from(
      { length: 100_000 },
      (_, index) => `p${String(index)}`,
    );

    const list = parseWatchlist(`${lines.join("\n")}\n`);

    expect(list.size).toBe(100_000);
  });

  it("rejects a list over 1 MiB", () => {
    const text = "a".repeat(1024 * 1024 + 1);

    expect(() => parseWatchlist(text)).toThrow(WatchlistError);
    expect(() => parseWatchlist(text)).toThrow(/1048576 bytes/u);
  });
});

describe("readWatchlist", () => {
  it("reads a file and reports the package rank", async () => {
    const file = join(base, "watchlist.txt");
    await writeFile(file, "alpha\nbeta\n", "utf8");

    const list = await readWatchlist(file);

    expect([...list]).toEqual([
      ["alpha", 0],
      ["beta", 1],
    ]);
  });

  it("reports a missing file as a WatchlistError with its path", async () => {
    const file = join(base, "missing.txt");

    const read = readWatchlist(file);

    await expect(read).rejects.toBeInstanceOf(WatchlistError);
    await expect(read).rejects.toThrow(/missing\.txt/u);
  });

  it("rejects an oversized file before parsing it", async () => {
    const file = join(base, "large.txt");
    await writeFile(file, "a".repeat(1024 * 1024 + 1), "utf8");

    const read = readWatchlist(file);

    await expect(read).rejects.toBeInstanceOf(WatchlistError);
    await expect(read).rejects.toThrow(/1048576 bytes/u);
  });
});
