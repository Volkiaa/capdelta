import { describe, expect, it } from "vitest";
import type { ChangedPackage } from "./contract/lockfile-diff.js";
import { lookupIntel, validateIntelUrl } from "./intel-client.js";

const CONFIRMED = {
  id: "CDI-0123456789abcdef0123",
  ecosystem: "npm",
  name: "left-pad",
  version: "2.0.0",
  digest: "sha512-new",
  verdict: "confirmed-malicious",
};

function changedPackage(name: string, newIntegrity: string): ChangedPackage {
  return {
    name,
    oldVersion: "1.0.0",
    newVersion: "2.0.0",
    oldIntegrity: "sha512-old",
    newIntegrity,
    oldResolvedUrl: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
    resolvedUrl: `https://registry.npmjs.org/${name}/-/${name}-2.0.0.tgz`,
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function jsonFetch(
  body: unknown,
  captured: CapturedRequest[] = [],
): typeof fetch {
  return (input, init) => {
    captured.push({
      url: input instanceof Request ? input.url : String(input),
      init,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function statusFetch(status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response("{}", {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

function hangingFetch(): typeof fetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
}

function networkErrorFetch(): typeof fetch {
  return () => Promise.reject(new TypeError("fetch failed"));
}

describe("validateIntelUrl", () => {
  it("accepts https and loopback http URLs", () => {
    for (const value of [
      "https://intel.example",
      "https://intel.example/api",
      "http://localhost:8080",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
    ]) {
      expect(validateIntelUrl(value).href).toBe(new URL(value).href);
    }
  });

  it("rejects a bad scheme, credentials, a query, a fragment, and plain http off loopback", () => {
    for (const value of [
      "file:///tmp/findings",
      "ftp://intel.example",
      "https://user:pass@intel.example",
      "https://user@intel.example",
      "http://example.com",
      "https://intel.example/?ecosystem=npm",
      "https://intel.example/#findings",
      "not a url",
      "",
    ]) {
      expect(() => validateIntelUrl(value)).toThrow(
        /intel URL|intelligence URL/iu,
      );
    }
  });
});

describe("lookupIntel", () => {
  it("returns findings for a digest and sends only the digest", async () => {
    const captured: CapturedRequest[] = [];
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      {
        baseUrl: "https://intel.example",
        fetchImpl: jsonFetch({ findings: [CONFIRMED] }, captured),
      },
    );

    expect(result).toEqual({ findings: [CONFIRMED], warnings: [] });
    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/findings");
    expect([...url.searchParams.keys()]).toEqual(["ecosystem", "digest"]);
    expect(url.searchParams.get("ecosystem")).toBe("npm");
    expect(url.searchParams.get("digest")).toBe("sha512-new");
    expect(request.url).not.toContain("left-pad");
    expect(request.init?.headers).toBeUndefined();
    expect(request.init?.redirect).toBe("error");
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("looks up each distinct digest once", async () => {
    const captured: CapturedRequest[] = [];
    await lookupIntel(
      [
        changedPackage("alpha", "sha512-same"),
        changedPackage("beta", "sha512-same"),
        changedPackage("gamma", "sha512-other"),
      ],
      {
        baseUrl: "https://intel.example",
        fetchImpl: jsonFetch({ findings: [] }, captured),
      },
    );
    expect(
      captured.map((request) =>
        new URL(request.url).searchParams.get("digest"),
      ),
    ).toEqual(["sha512-same", "sha512-other"]);
  });

  it("adds one warning for a network error and keeps going", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      { baseUrl: "https://intel.example", fetchImpl: networkErrorFetch() },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (network-error); continuing with local analysis only",
    ]);
  });

  it("adds one warning for a request timeout and keeps going", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      {
        baseUrl: "https://intel.example",
        fetchImpl: hangingFetch(),
        requestTimeoutMs: 10,
      },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (timeout); continuing with local analysis only",
    ]);
  });

  it("adds one warning for a total timeout and keeps going", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      {
        baseUrl: "https://intel.example",
        fetchImpl: hangingFetch(),
        requestTimeoutMs: 1_000,
        totalTimeoutMs: 10,
      },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (timeout); continuing with local analysis only",
    ]);
  });

  it("adds one warning for a non-200 response and keeps going", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      { baseUrl: "https://intel.example", fetchImpl: statusFetch(500) },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (http-status); continuing with local analysis only",
    ]);
  });

  it("adds one warning when the body exceeds the byte cap", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      {
        baseUrl: "https://intel.example",
        fetchImpl: () =>
          Promise.resolve(new Response(new Uint8Array(64), { status: 200 })),
        maxResponseBytes: 16,
      },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (oversize-body); continuing with local analysis only",
    ]);
  });

  it("adds one warning for invalid JSON and keeps going", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      {
        baseUrl: "https://intel.example",
        fetchImpl: () =>
          Promise.resolve(new Response("not json", { status: 200 })),
      },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (invalid-json); continuing with local analysis only",
    ]);
  });

  it("adds one warning for a wrong response shape and keeps going", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      { baseUrl: "https://intel.example", fetchImpl: jsonFetch({ hits: [] }) },
    );
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([
      "intelligence service unavailable (invalid-shape); continuing with local analysis only",
    ]);
  });

  it("skips entries with a wrong field type and warns once", async () => {
    const result = await lookupIntel(
      [changedPackage("left-pad", "sha512-new")],
      {
        baseUrl: "https://intel.example",
        fetchImpl: jsonFetch({
          findings: [
            CONFIRMED,
            { ...CONFIRMED, name: 7 },
            { ...CONFIRMED, verdict: null },
            "not an entry",
          ],
        }),
      },
    );
    expect(result.findings).toEqual([CONFIRMED]);
    expect(result.warnings).toEqual([
      "intelligence service returned 3 invalid findings; continuing with local analysis only",
    ]);
  });

  it("caps lookups at maxPackages and names how many were not checked", async () => {
    const captured: CapturedRequest[] = [];
    const result = await lookupIntel(
      [
        changedPackage("alpha", "sha512-a"),
        changedPackage("beta", "sha512-b"),
        changedPackage("gamma", "sha512-c"),
      ],
      {
        baseUrl: "https://intel.example",
        fetchImpl: jsonFetch({ findings: [] }, captured),
        maxPackages: 2,
      },
    );
    expect(captured).toHaveLength(2);
    expect(result.warnings).toEqual([
      "intelligence service skipped 1 of 3 package digests beyond the 2 limit; continuing with local analysis only",
    ]);
  });

  it("returns nothing for an unchanged lockfile without calling the service", async () => {
    let calls = 0;
    const result = await lookupIntel([], {
      baseUrl: "https://intel.example",
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    expect(result).toEqual({ findings: [], warnings: [] });
    expect(calls).toBe(0);
  });
});
