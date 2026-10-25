/**
 * ADR-0043: a configured registry host is one exact DNS host. The lockfile
 * differ matches it by string equality, so no prefix, suffix or wildcard rule
 * can widen what the allowlist covers.
 */

export const NPM_REGISTRY_HOST = "registry.npmjs.org";

export const MAX_CONFIGURED_REGISTRY_HOSTS = 32;

/** One DNS host: lowercase letters and digits, dots and inner hyphens only. */
function isDnsHost(host: string): boolean {
  if (!/^[a-z0-9.-]+$/u.test(host)) return false;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return false;
  }
  return host
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-"),
    );
}

/**
 * Return the normalized host, or null when the value is not exactly one DNS
 * host. Rejects a scheme, port, credentials, path, wildcard, IDN spelling and
 * a host that embeds `registry.npmjs.org` without being it, so a skimmed
 * config cannot hide a look-alike of the npm registry.
 */
export function normalizeRegistryHost(value: string): string | null {
  const host = value.toLowerCase();
  if (host.length === 0) return null;
  if (host !== NPM_REGISTRY_HOST && host.includes(NPM_REGISTRY_HOST)) {
    return null;
  }
  if (!isDnsHost(host)) return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    return null;
  }
  if (
    parsed.host !== host ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return host;
}

/**
 * The hosts a differ may analyze. `registry.npmjs.org` is always included, so
 * base policy can never stop analyzing npm packages (ADR-0043).
 */
export function registryHostSet(
  hosts: readonly string[] = [],
): ReadonlySet<string> {
  return new Set([NPM_REGISTRY_HOST, ...hosts]);
}
