/** One published version, as recorded by the registry. */
export interface ReleaseArtifact {
  version: string;
  /** `dist.integrity`, always a sha512 SRI token. */
  digest: string;
  /** `dist.tarball`, on the configured registry host. */
  tarballUrl: string;
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
}
