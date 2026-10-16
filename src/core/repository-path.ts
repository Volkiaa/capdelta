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
