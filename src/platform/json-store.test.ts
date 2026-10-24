import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeKey,
  JsonStore,
  JsonStoreCorruptError,
  JsonStoreError,
} from "./json-store.js";

let base: string;
let root: string;
let store: JsonStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "capdelta-json-store-"));
  root = join(base, "root");
  store = new JsonStore({ root });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("JsonStore.get", () => {
  it("returns a value that put stored", async () => {
    const value = { name: "capdelta", nested: { count: 2, tags: ["a", "b"] } };
    await store.put("reports", "key-1", value);

    await expect(store.get("reports", "key-1")).resolves.toEqual(value);
  });

  it("returns null for a missing key", async () => {
    await expect(store.get("reports", "absent")).resolves.toBeNull();
  });
});

describe("JsonStore.putIfAbsent", () => {
  it("writes once and keeps the first value", async () => {
    await expect(
      store.putIfAbsent("reports", "key-1", { count: 1 }),
    ).resolves.toBe(true);
    await expect(
      store.putIfAbsent("reports", "key-1", { count: 2 }),
    ).resolves.toBe(false);

    await expect(store.get("reports", "key-1")).resolves.toEqual({ count: 1 });
  });

  it("lets exactly one of twenty concurrent callers win", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.putIfAbsent("reports", "race", { index }),
      ),
    );

    const winners = results.flatMap((won, index) => (won ? [index] : []));
    expect(winners).toHaveLength(1);
    await expect(store.get("reports", "race")).resolves.toEqual({
      index: winners[0],
    });
  });
});

describe("JsonStore.put", () => {
  it("overwrites an existing record", async () => {
    await store.put("reports", "key-1", { count: 1 });
    await store.put("reports", "key-1", { count: 2 });

    await expect(store.get("reports", "key-1")).resolves.toEqual({ count: 2 });
  });

  it("writes indented JSON to kind/key.json", async () => {
    await store.put("reports", "key-1", { count: 1 });

    const text = await readFile(join(root, "reports", "key-1.json"), "utf8");
    expect(text).toBe('{\n  "count": 1\n}\n');
  });

  it("rejects a value with no JSON form and leaves no record", async () => {
    await expect(
      store.put("reports", "nothing", undefined),
    ).rejects.toBeInstanceOf(JsonStoreError);
    await expect(
      store.putIfAbsent("reports", "nothing", () => undefined),
    ).rejects.toBeInstanceOf(JsonStoreError);

    await expect(store.list("reports")).resolves.toEqual([]);
  });

  it("rejects a circular value with a store error", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      store.put("reports", "circular", circular),
    ).rejects.toBeInstanceOf(JsonStoreError);
  });

  it("leaves no temp files behind on any write path", async () => {
    await store.put("reports", "one", 1);
    await store.putIfAbsent("reports", "two", 2);
    await store.putIfAbsent("reports", "two", 3);

    const files = await readdir(join(root, "reports"));
    expect(files.sort()).toEqual(["one.json", "two.json"]);
  });
});

describe("JsonStore.list", () => {
  it("returns keys sorted, ignoring temp and non-JSON files", async () => {
    await store.put("reports", "b", 1);
    await store.put("reports", "a", 2);
    await store.put("reports", "c", 3);
    await writeFile(join(root, "reports", ".a.0123.tmp"), "{");
    await writeFile(join(root, "reports", "notes.txt"), "not a record");

    await expect(store.list("reports")).resolves.toEqual(["a", "b", "c"]);
  });

  it("returns an empty list for a missing kind", async () => {
    await expect(store.list("reports")).resolves.toEqual([]);
  });
});

describe("JsonStore.delete", () => {
  it("removes a record and tolerates a missing one", async () => {
    await store.put("reports", "key-1", { count: 1 });

    await store.delete("reports", "key-1");
    await expect(store.get("reports", "key-1")).resolves.toBeNull();
    await expect(store.delete("reports", "key-1")).resolves.toBeUndefined();
  });
});

describe("JsonStore validation", () => {
  const invalidKinds = ["../x", "a/b", "", ".", "Upper", "x".repeat(33)];

  for (const kind of invalidKinds) {
    it(`rejects kind ${JSON.stringify(kind)} without touching the disk`, async () => {
      await expect(
        store.put(kind, "key-1", { count: 1 }),
      ).rejects.toBeInstanceOf(JsonStoreError);
      await expect(store.get(kind, "key-1")).rejects.toBeInstanceOf(
        JsonStoreError,
      );
      await expect(store.list(kind)).rejects.toBeInstanceOf(JsonStoreError);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(base)).resolves.toEqual([]);
    });
  }

  const invalidKeys = [
    "../x",
    "a/b",
    "",
    ".",
    "..",
    "x".repeat(201),
    "upper space",
  ];

  for (const key of invalidKeys) {
    it(`rejects key ${JSON.stringify(key)} without touching the disk`, async () => {
      await expect(
        store.put("reports", key, { count: 1 }),
      ).rejects.toBeInstanceOf(JsonStoreError);
      await expect(store.get("reports", key)).rejects.toBeInstanceOf(
        JsonStoreError,
      );
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(base)).resolves.toEqual([]);
    });
  }
});

describe("JsonStore.get with a damaged file", () => {
  it("throws a corrupt-record error for truncated JSON", async () => {
    await mkdir(join(root, "reports"), { recursive: true });
    await writeFile(join(root, "reports", "broken.json"), '{"a":');

    await expect(store.get("reports", "broken")).rejects.toBeInstanceOf(
      JsonStoreCorruptError,
    );
    await expect(store.get("reports", "broken")).rejects.toThrow(
      'kind "reports" key "broken"',
    );
  });

  it("ignores a temp file left by a crashed writer", async () => {
    await store.put("reports", "kept", { count: 1 });
    await writeFile(join(root, "reports", ".kept.abc123.tmp"), '{"partial":');

    await expect(store.list("reports")).resolves.toEqual(["kept"]);
    await expect(store.get("reports", "kept")).resolves.toEqual({ count: 1 });
  });
});

describe("JsonStore symlink defenses", () => {
  it("rejects a symlinked kind directory without touching its target", async () => {
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "reports"), "dir");

    await expect(
      store.put("reports", "key-1", { count: 1 }),
    ).rejects.toBeInstanceOf(JsonStoreError);
    await expect(
      store.putIfAbsent("reports", "key-1", { count: 1 }),
    ).rejects.toBeInstanceOf(JsonStoreError);
    await expect(store.get("reports", "key-1")).rejects.toBeInstanceOf(
      JsonStoreError,
    );
    await expect(store.list("reports")).rejects.toBeInstanceOf(JsonStoreError);
    await expect(store.delete("reports", "key-1")).rejects.toBeInstanceOf(
      JsonStoreError,
    );

    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it("rejects a file at the kind path for every operation", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "reports"), "occupied");

    await expect(
      store.put("reports", "key-1", { count: 1 }),
    ).rejects.toBeInstanceOf(JsonStoreError);
    await expect(store.get("reports", "key-1")).rejects.toBeInstanceOf(
      JsonStoreError,
    );
    await expect(store.list("reports")).rejects.toBeInstanceOf(JsonStoreError);
    await expect(store.delete("reports", "key-1")).rejects.toBeInstanceOf(
      JsonStoreError,
    );
  });

  it("throws instead of following a symlinked record", async () => {
    const outside = join(base, "outside");
    await mkdir(outside, { recursive: true });
    const target = join(outside, "secret.json");
    await writeFile(target, '{"secret":true}\n');
    await mkdir(join(root, "reports"), { recursive: true });
    await symlink(target, join(root, "reports", "key-1.json"), "file");

    await expect(store.get("reports", "key-1")).rejects.toBeInstanceOf(
      JsonStoreError,
    );
  });

  it("skips symlinked records when listing", async () => {
    await store.put("reports", "kept", { count: 1 });
    const target = join(base, "outside.json");
    await writeFile(target, '{"outside":true}\n');
    await symlink(target, join(root, "reports", "linked.json"), "file");

    await expect(store.list("reports")).resolves.toEqual(["kept"]);
  });

  it("still reads and writes a real kind directory", async () => {
    await store.put("reports", "key-1", { count: 1 });

    await expect(store.get("reports", "key-1")).resolves.toEqual({ count: 1 });
    await expect(store.list("reports")).resolves.toEqual(["key-1"]);
    await store.delete("reports", "key-1");
    await expect(store.get("reports", "key-1")).resolves.toBeNull();
  });
});

describe("JsonStore errors", () => {
  it("names the kind and key when the directory cannot be created", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "reports"), "occupied");

    await expect(store.put("reports", "key-1", { count: 1 })).rejects.toThrow(
      'kind "reports" key "key-1"',
    );
  });
});

describe("encodeKey", () => {
  it("returns stable lowercase hex that passes the key rule", () => {
    const encoded = encodeKey("@scope/pkg");

    expect(encoded).toBe(
      "5b9874c85552b75061838aafc67837b8729af38b13f6b15333cdb0cf5cbb9911",
    );
    expect(encoded).toMatch(/^[A-Za-z0-9._-]{1,200}$/);
    expect(encodeKey("@scope/pkg")).toBe(encoded);
  });

  it("produces a key the store accepts", async () => {
    const key = encodeKey("@scope/pkg");
    await store.put("packages", key, { name: "@scope/pkg" });

    await expect(store.get("packages", key)).resolves.toEqual({
      name: "@scope/pkg",
    });
  });
});
