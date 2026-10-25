/** One published version, as recorded by the registry. */
export interface ReleaseArtifact {
  version: string;
  /** `dist.integrity`, always a sha512 SRI token. */
  digest: string;
  /** `dist.tarball`, on the configured registry host. */
  tarballUrl: string;
}

/** A resolved dependency the release newly declares (ADR-045). */
export interface ReleaseChild {
  name: string;
  artifact: ReleaseArtifact;
}

/** A new dependency the collector could not resolve. It makes the record incomplete. */
export interface UnresolvedReleaseChild {
  name: string;
  reason: string;
}

/** A registry version that is ready for analysis. */
export interface ReleaseCandidate {
  ecosystem: "npm";
  name: string;
  version: string;
  digest: string;
  tarballUrl: string;
  /** The version published immediately before this one, null for a first release. */
  previous: ReleaseArtifact | null;
  /** ISO time from `packument.time[version]`. */
  publishedAt: string;
  /** Newly declared dependencies, depth 1, at most 8 (ADR-045). */
  children?: ReleaseChild[];
  /** New dependencies that could not be resolved; every entry is loud. */
  unresolvedChildren?: UnresolvedReleaseChild[];
}
