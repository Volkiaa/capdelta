import { createHash, randomBytes } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { NamedError } from "../core/named-error.js";
import { MAX_IDENTITY_CHARS, truncate } from "../core/report-builder.js";

export class JsonStoreError extends NamedError {}
export class JsonStoreCorruptError extends JsonStoreError {}

export interface JsonStoreOptions {
  root: string;
}

const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const RECORD_SUFFIX = ".json";

/**
 * Threat model: the root is a directory only the operator can write. Key
 * validation and symlink checks stop attacker-controlled names (package
 * names, versions) from escaping it. A local attacker who can swap
 * directories inside the root can win a check-then-use race, because Node has
 * no openat; protect the root with file permissions.
 */
export class JsonStore {
  private readonly root: string;

  constructor(options: JsonStoreOptions) {
    this.root = options.root;
  }

  /**
   * Returns null when the key does not exist. `unknown` already includes null,
   * so the union in the ticket's sketch adds nothing.
   * @throws JsonStoreCorruptError when the file is not valid JSON.
   * @throws JsonStoreError when the kind path or the record is not a real
   *   directory or file, so a symlink cannot redirect the read.
   */
  async get(kind: string, key: string): Promise<unknown> {
    requireKind(kind);
    requireKey(key);
    await this.inspectKindDirectory(kind, key);
    const recordPath = this.pathFor(kind, key);

    let handle: FileHandle;
    try {
      handle = await open(
        recordPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw wrap("read", kind, key, error);
    }

    let text = "";
    let failure: JsonStoreError | undefined;
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new JsonStoreError(
          `cannot read kind "${kind}" key "${key}": it is not a regular file`,
        );
      }
      text = await handle.readFile("utf8");
    } catch (error) {
      failure =
        error instanceof JsonStoreError
          ? error
          : wrap("read", kind, key, error);
    }

    try {
      await handle.close();
    } catch (error) {
      const closeFailure = wrap("close the record for", kind, key, error);
      failure =
        failure === undefined
          ? closeFailure
          : new JsonStoreError(
              `${failure.message}; closing it also failed: ${closeFailure.message}`,
              { cause: new AggregateError([failure, closeFailure]) },
            );
    }

    if (failure !== undefined) throw failure;

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new JsonStoreCorruptError(
        `corrupt record for kind "${kind}" key "${key}": ${detail(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Writes only when the key is absent.
   * @returns true when it wrote, false when the key already existed.
   */
  async putIfAbsent(
    kind: string,
    key: string,
    value: unknown,
  ): Promise<boolean> {
    requireKind(kind);
    requireKey(key);
    const content = serialize(kind, key, value);
    const tempPath = await this.writeTemp(kind, key, content);

    try {
      try {
        await link(tempPath, this.pathFor(kind, key));
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false;
        throw wrap("write", kind, key, error);
      }
      return true;
    } finally {
      await removeTemp(tempPath, kind, key);
    }
  }

  /** Overwrites atomically through a temp file in the same directory, then a rename. */
  async put(kind: string, key: string, value: unknown): Promise<void> {
    requireKind(kind);
    requireKey(key);
    const content = serialize(kind, key, value);
    const tempPath = await this.writeTemp(kind, key, content);

    try {
      await rename(tempPath, this.pathFor(kind, key));
    } catch (error) {
      await removeTemp(tempPath, kind, key);
      throw wrap("write", kind, key, error);
    }
  }

  /** Keys of one kind in sorted order. An absent kind directory lists as empty. */
  async list(kind: string): Promise<string[]> {
    requireKind(kind);
    await this.inspectKindDirectory(kind, undefined);

    let entries: Dirent[];
    try {
      entries = await readdir(join(this.root, kind), { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return [];
      throw wrap("list", kind, undefined, error);
    }

    return entries
      .filter((entry) => {
        // isFile() is false for symlinks, sockets, and directories.
        return entry.isFile() && entry.name.endsWith(RECORD_SUFFIX);
      })
      .map((entry) => entry.name.slice(0, -RECORD_SUFFIX.length))
      .sort();
  }

  /** Removes a record. A missing record is not an error. */
  async delete(kind: string, key: string): Promise<void> {
    requireKind(kind);
    requireKey(key);
    await this.inspectKindDirectory(kind, key);

    try {
      await unlink(this.pathFor(kind, key));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw wrap("delete", kind, key, error);
    }
  }

  /**
   * Rejects a kind path that exists but is not a real directory. A symlink
   * here would redirect every operation outside the store.
   * @returns whether the kind path exists as a real directory.
   */
  private async inspectKindDirectory(
    kind: string,
    key: string | undefined,
  ): Promise<boolean> {
    let stats: Stats;
    try {
      stats = await lstat(join(this.root, kind));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw wrap("inspect the directory for", kind, key, error);
    }
    if (!stats.isDirectory()) {
      throw new JsonStoreError(
        `cannot use the directory for ${describe(kind, key)}: it exists but is not a real directory (a symlink or a file)`,
      );
    }
    return true;
  }

  /** Creates the root and the kind directory without following a kind symlink. */
  private async ensureKindDirectory(
    kind: string,
    key: string,
  ): Promise<string> {
    try {
      await mkdir(this.root, { recursive: true });
    } catch (error) {
      throw wrap("create the root directory for", kind, key, error);
    }

    if (!(await this.inspectKindDirectory(kind, key))) {
      try {
        await mkdir(join(this.root, kind));
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw wrap("create the directory for", kind, key, error);
        }
        // Another writer may have won the mkdir race; it must still be a
        // real directory, not a symlink that appeared in between.
        await this.inspectKindDirectory(kind, key);
      }
    }
    return join(this.root, kind);
  }

  private pathFor(kind: string, key: string): string {
    return join(this.root, kind, `${key}${RECORD_SUFFIX}`);
  }

  private async writeTemp(
    kind: string,
    key: string,
    content: string,
  ): Promise<string> {
    const directory = await this.ensureKindDirectory(kind, key);

    const tempPath = join(
      directory,
      `.${key}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let handle: FileHandle;
    try {
      handle = await open(tempPath, "wx", 0o600);
    } catch (error) {
      throw wrap("open a temporary file for", kind, key, error);
    }

    let failure: JsonStoreError | undefined;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      failure = wrap("write", kind, key, error);
    }

    try {
      await handle.close();
    } catch (error) {
      const closeFailure = wrap(
        "close the temporary file for",
        kind,
        key,
        error,
      );
      failure =
        failure === undefined
          ? closeFailure
          : new JsonStoreError(
              `${failure.message}; closing it also failed: ${closeFailure.message}`,
              { cause: new AggregateError([failure, closeFailure]) },
            );
    }

    if (failure !== undefined) {
      await removeTemp(tempPath, kind, key);
      throw failure;
    }
    return tempPath;
  }
}

/** Lowercase hex SHA-256 of a caller's natural key, for keys the regex rejects. */
export function encodeKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function requireKind(kind: string): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new JsonStoreError(
      `invalid kind ${quote(kind)}: expected ${KIND_PATTERN.source}`,
    );
  }
}

function requireKey(key: string): void {
  if (key === "." || key === ".." || !KEY_PATTERN.test(key)) {
    throw new JsonStoreError(
      `invalid key ${quote(key)}: expected ${KEY_PATTERN.source} and not "." or ".."`,
    );
  }
}

function quote(value: string): string {
  return JSON.stringify(truncate(value, MAX_IDENTITY_CHARS));
}

// JSON.stringify's type says string, but it returns undefined for a top-level
// undefined, function, or symbol.
function stringify(value: unknown): string | undefined {
  return JSON.stringify(value, null, 2);
}

function serialize(kind: string, key: string, value: unknown): string {
  let text: string | undefined;
  try {
    text = stringify(value);
  } catch (error) {
    throw wrap("serialize the value for", kind, key, error);
  }
  if (text === undefined) {
    throw new JsonStoreError(
      `cannot serialize the value for kind "${kind}" key "${key}": it has no JSON form`,
    );
  }
  return `${text}\n`;
}

async function removeTemp(
  path: string,
  kind: string,
  key: string,
): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    throw wrap("remove the temporary file for", kind, key, error);
  }
}

function describe(kind: string, key: string | undefined): string {
  return key === undefined ? `kind "${kind}"` : `kind "${kind}" key "${key}"`;
}

function wrap(
  action: string,
  kind: string,
  key: string | undefined,
  error: unknown,
): JsonStoreError {
  return new JsonStoreError(
    `cannot ${action} ${describe(kind, key)}: ${detail(error)}`,
    { cause: error },
  );
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}
