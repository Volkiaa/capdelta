import { mkdir } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import * as tar from "tar";

const fixtureRoot = fileURLToPath(
  new URL("../test/fixtures/golden/install-script-added/", import.meta.url),
);

await mkdir(fixtureRoot, { recursive: true });
for (const version of ["v1", "v2"]) {
  await tar.c(
    {
      cwd: `${fixtureRoot}/source-${version}`,
      file: `${fixtureRoot}/${version}.tgz`,
      gzip: true,
      portable: true,
      mtime: new Date(0),
    },
    // npm pack archives file paths beneath package/ without requiring an
    // explicit trailing-slash directory entry.
    ["package/package.json"],
  );
}
