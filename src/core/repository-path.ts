/**
 * A repository-relative POSIX path with no way to escape or alias the root:
 * non-empty, no leading slash, no backslash or NUL, and no empty, `.`, or
 * `..` segments. Pure check; it never normalizes rejected input.
 */
export function isNormalizedRelativePosixPath(path: string): boolean {
  return !(
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  );
}
