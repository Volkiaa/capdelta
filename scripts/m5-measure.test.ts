import { describe, expect, it } from "vitest";
import type {
  CapabilitySet,
  Evidence,
  SignalEndpointContext,
  SignalEndpointObservation,
} from "../src/core/contract/capability-set.js";
import { diffCapabilities } from "../src/core/capability-differ.js";
import type { JsonRunReport } from "../src/core/report-contract.js";
import {
  collectEndpointContexts,
  isTransient,
  recordingDiffAdapter,
} from "./m5-measure.js";

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

function capabilitySet(
  version: string,
  endpoints: SignalEndpointObservation[] = [],
): CapabilitySet {
  return {
    schemaVersion: 1,
    subject: { ecosystem: "npm", name: "demo", version },
    completeness: "complete",
    capabilities: [],
    diagnostics: [],
    signals: { sourceFiles: [], endpoints, obfuscationPatterns: [] },
  };
}

function endpoint(
  host: string,
  context: SignalEndpointContext,
  evidence: Evidence,
  endpointType: SignalEndpointObservation["endpointType"] = "domain",
): SignalEndpointObservation {
  return {
    kind: "EXTERNAL_ENDPOINT",
    endpointType,
    normalizedValue: host,
    confidence: "literal",
    context,
    provenance: "established",
    evidence: [evidence],
  };
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

describe("m5 contexts", () => {
  it("collects domain observations in host, file, line order with totals", () => {
    const longSnippet = "s".repeat(250);
    const set = capabilitySet("2.0.0", [
      endpoint("z.example", "embedded-text", {
        file: "lib/z.js",
        line: 7,
        snippet: longSnippet,
      }),
      endpoint(
        "10.0.0.1",
        "unknown",
        {
          file: "lib/ip.js",
          line: 1,
          snippet: "const ip = '10.0.0.1';",
        },
        "ipv4",
      ),
      {
        ...endpoint("a.example", "literal", {
          file: "index.js",
          line: 12,
          snippet: "fetch('https://a.example');",
        }),
        evidence: [
          {
            file: "index.js",
            line: 12,
            snippet: "fetch('https://a.example');",
          },
          { file: "lib/later.js", line: 4, snippet: "later evidence" },
        ],
      },
      endpoint("a.example", "unknown", {
        file: "lib/a.js",
        line: 3,
        snippet: "second occurrence",
      }),
    ]);

    const collected = collectEndpointContexts(set);

    expect(collected.observations).toEqual([
      {
        host: "a.example",
        context: "literal",
        file: "index.js",
        line: 12,
        snippet: "fetch('https://a.example');",
      },
      {
        host: "a.example",
        context: "unknown",
        file: "lib/a.js",
        line: 3,
        snippet: "second occurrence",
      },
      {
        host: "z.example",
        context: "embedded-text",
        file: "lib/z.js",
        line: 7,
        snippet: `${"s".repeat(199)}\u2026`,
      },
    ]);
    expect(collected.totals).toEqual({
      literal: 1,
      "embedded-text": 1,
      unknown: 1,
    });
  });

  it("returns no observations for an unavailable package", () => {
    expect(collectEndpointContexts(null)).toEqual({
      observations: [],
      totals: { literal: 0, "embedded-text": 0, unknown: 0 },
    });
  });
});

describe("m5 recording diff adapter", () => {
  it("records the new set and returns the differ result unchanged", () => {
    const recorder: { newSet: CapabilitySet | null } = { newSet: null };
    const adapter = recordingDiffAdapter(recorder);
    const oldSet = capabilitySet("1.0.0");
    const newSet: CapabilitySet = {
      ...capabilitySet("2.0.0"),
      capabilities: [
        {
          kind: "DEPENDENCY",
          location: { kind: "manifest" },
          name: "left-pad",
          requirement: "^1.0.0",
          evidence: [
            {
              file: "package.json",
              line: 1,
              snippet: '"left-pad": "^1.0.0"',
            },
          ],
        },
      ],
    };

    const result = adapter(oldSet, newSet);

    expect(recorder.newSet).toBe(newSet);
    expect(result).toEqual(diffCapabilities(oldSet, newSet));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.capability.kind).toBe("DEPENDENCY");
  });
});
