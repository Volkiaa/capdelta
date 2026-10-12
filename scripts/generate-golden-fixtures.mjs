// Packs every golden case listed in test/fixtures/golden/cases.json into
// deterministic npm-style tarballs. It only reads and archives fixture bytes:
// it never imports fixture code or runs npm, lifecycle hooks, or installs.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import * as tar from "tar";

const goldenRoot = fileURLToPath(
  new URL("../test/fixtures/golden/", import.meta.url),
);
const cases = JSON.parse(
  await readFile(join(goldenRoot, "cases.json"), "utf8"),
);

for (const goldenCase of cases) {
  const caseRoot = join(goldenRoot, goldenCase.name);
  const integrities = {};
  for (const version of ["v1", "v2"]) {
    const sourceRoot = join(caseRoot, `source-${version}`);
    const files = await listRegularFiles(sourceRoot, "package");
    const tarball = join(caseRoot, `${version}.tgz`);
    await tar.c(
      {
        cwd: sourceRoot,
        file: tarball,
        gzip: true,
        portable: true,
        mtime: new Date(0),
      },
      // npm pack archives file paths beneath package/ without requiring an
      // explicit trailing-slash directory entry.
      files,
    );
    integrities[version] = `sha512-${createHash("sha512")
      .update(await readFile(tarball))
      .digest("base64")}`;
  }
  if (goldenCase.mode === "lockfile") {
    await writeLockfile(
      join(caseRoot, "old-lockfile.json"),
      goldenCase,
      goldenCase.oldVersion,
      goldenCase.oldResolvedUrl,
      integrities.v1,
    );
    await writeLockfile(
      join(caseRoot, "new-lockfile.json"),
      goldenCase,
      goldenCase.newVersion,
      goldenCase.newResolvedUrl,
      integrities.v2,
    );
  }
}

/** Sorted relative paths of regular files; symlinks and others are refused. */
async function listRegularFiles(root, relative) {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    // Dirent types describe the entry itself; symlinks are never followed.
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`golden fixture ${path} is not a regular file`);
    }
  }
  return files;
}

async function writeLockfile(path, goldenCase, version, resolved, integrity) {
  const lockfile = {
    name: "golden-lockfile-project",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "golden-lockfile-project", version: "1.0.0" },
      [`node_modules/${goldenCase.packageName}`]: {
        version,
        resolved,
        integrity,
      },
    },
  };
  await writeFile(path, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}
