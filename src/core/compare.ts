import type { Evidence } from "./contract/capability-set.js";

// UTF-16 code-unit order, as in the default Array.prototype.sort, never locale order.
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareEvidence(left: Evidence, right: Evidence): number {
  return compareText(
    JSON.stringify([left.file, left.line, left.snippet]),
    JSON.stringify([right.file, right.line, right.snippet]),
  );
}
