import type {
  ChangedPackage,
  LockfileFinding,
} from "./contract/lockfile-diff.js";
import { compareText } from "./compare.js";

/**
 * ADR-039 item 8: one published feed entry, reduced to the fields the lockfile
 * match needs. `verdict` stays a string because a feed read at runtime may
 * carry a state this build does not know; an unknown state never matches.
 */
export interface IntelFindingView {
  id: string;
  ecosystem: string;
  name: string;
  version: string;
  digest: string;
  verdict: string;
}

/**
 * ADR-039 item 8: a lockfile change matches a published finding only on the
 * exact artifact identity (ecosystem, name, version, digest), and only a
 * human `confirmed-malicious` verdict produces a finding. A `retracted` entry
 * and every other verdict produce nothing.
 */
export function intelMatches(
  changed: readonly ChangedPackage[],
  findings: readonly IntelFindingView[],
): LockfileFinding[] {
  const matched: LockfileFinding[] = [];
  const seen = new Set<string>();
  for (const pkg of changed) {
    for (const finding of findings) {
      if (
        finding.ecosystem !== "npm" ||
        finding.name !== pkg.name ||
        finding.version !== pkg.newVersion ||
        finding.digest !== pkg.newIntegrity ||
        finding.verdict !== "confirmed-malicious"
      ) {
        continue;
      }
      // ADR-039 item 8: one finding per matched package and finding id, so a
      // feed that repeats an entry cannot double-count the gate.
      const key = `${pkg.name}\0${pkg.newVersion}\0${pkg.newIntegrity}\0${finding.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matched.push({
        kind: "intel-confirmed-malicious",
        name: pkg.name,
        path: `intel:${finding.id}`,
        oldVersion: pkg.oldVersion,
        newVersion: pkg.newVersion,
        intelId: finding.id,
      });
    }
  }
  return matched.sort(
    (left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.intelId ?? "", right.intelId ?? ""),
  );
}
