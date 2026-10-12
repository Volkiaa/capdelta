import { describe, expect, it } from "vitest";
import type { JsonRunReport } from "../src/core/report-contract.js";
import { isTransient } from "./m5-measure.js";

function unavailable(
  failures: { stage: string; kind: string }[],
): JsonRunReport {
  return {
    packages: [
      {
        status: "unavailable",
        failures: failures.map((failure) => ({
          ...failure,
          side: "new",
          detail: "",
          url: null,
          evidence: null,
          severity: null,
        })),
      },
    ],
  } as unknown as JsonRunReport;
}

describe("m5 retry policy", () => {
  it("retries only when every failure is a transient fetch error", () => {
    expect(
      isTransient(unavailable([{ stage: "fetch", kind: "network-error" }])),
    ).toBe(true);
    expect(
      isTransient(unavailable([{ stage: "fetch", kind: "timeout" }])),
    ).toBe(true);
    expect(
      isTransient(
        unavailable([{ stage: "fetch", kind: "integrity-mismatch" }]),
      ),
    ).toBe(false);
    expect(
      isTransient(
        unavailable([{ stage: "new-extraction", kind: "file-count-limit" }]),
      ),
    ).toBe(false);
    expect(
      isTransient(
        unavailable([
          { stage: "fetch", kind: "network-error" },
          { stage: "fetch", kind: "http-status" },
        ]),
      ),
    ).toBe(false);
    expect(isTransient({ packages: [] } as unknown as JsonRunReport)).toBe(
      false,
    );
  });
});
