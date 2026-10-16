// PLAN §10
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RUNTIME_DEPS_EXCLUSIVE_LIMIT = 10;

export function countDirectRuntimeDeps(manifest) {
  return Object.keys(manifest.dependencies ?? {}).length;
}

/**
 * Counts installed runtime packages in an npm lockfile v2/v3 `packages` map:
 * every entry under node_modules/ that is not marked dev-only. The path rule
 * (must contain "node_modules/") matches isDependencyPath in
 * src/core/npm/lockfile-differ.ts, so the root entry ("") and workspace
 * source dirs are excluded by both. Intentional difference: the differ also
 * analyzes dev entries (their install scripts run on `npm install` too),
 * while this budget counts runtime-only.
 * @param {{ packages?: Record<string, { dev?: boolean }> }} lockfile
 */
export function countTransitiveRuntimeDeps(lockfile) {
  const packages = lockfile.packages ?? {};
  return Object.entries(packages).filter(
    ([path, meta]) => path.includes("node_modules/") && meta.dev !== true,
  ).length;
}

function main() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));

  const direct = countDirectRuntimeDeps(manifest);
  const transitive = countTransitiveRuntimeDeps(lockfile);

  console.log(
    `Runtime dependencies (direct):     ${String(direct)} / budget < ${String(RUNTIME_DEPS_EXCLUSIVE_LIMIT)}`,
  );
  console.log(
    `Runtime packages incl. transitive: ${String(transitive)} (reported, not gated)`,
  );

  if (direct >= RUNTIME_DEPS_EXCLUSIVE_LIMIT) {
    console.error(
      `\nDependency budget exceeded: ${String(direct)} direct runtime dependencies ` +
        `(budget: fewer than ${String(RUNTIME_DEPS_EXCLUSIVE_LIMIT)}, PLAN §10). ` +
        "Removing one, or an approved ADR raising the budget, is required.",
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
