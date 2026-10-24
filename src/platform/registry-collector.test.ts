import { describe, expect, it } from "vitest";
import {
  CollectorError,
  candidatesForPackage,
  collectReleases,
} from "./registry-collector.js";

const REGISTRY = "https://registry.npmjs.org";
const CHANGES = "https://replicate.npmjs.com/_changes";

interface FixtureVersion {
  version: string;
  publishedAt: string;
  integrity?: string | null;
  tarball?: string;
}

function packument(name: string, versions: readonly FixtureVersion[]): unknown {
  const doc: {
    name: string;
    versions: Record<string, unknown>;
    time: Record<string, string>;
  } = { name, versions: {}, time: { created: "2020-01-01T00:00:00.000Z" } };
  for (const item of versions) {
    doc.versions[item.version] = {
      name,
      version: item.version,
      dist: {
        ...(item.integrity === null
          ? {}
          : { integrity: item.integrity ?? "sha512-AAAA" }),
        tarball: item.tarball ?? `${REGISTRY}/${name}/-/${item.version}.tgz`,
      },
    };
    doc.time[item.version] = item.publishedAt;
  }
  doc.time.modified = "2021-01-01T00:00:00.000Z";
  return doc;
}

function requestedUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Routes requests by their full URL. A miss fails loudly. */
function routedFetch(routes: ReadonlyMap<string, Response>): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = requestedUrl(input);
    requested.push(url);
    const response = routes.get(url);
    if (response === undefined) throw new Error(`unexpected request: ${url}`);
    return Promise.resolve(response);
  };
  return { fetchImpl, requested };
}

describe("collectReleases", () => {
  it("collects candidates for every non-design package in the feed", async () => {
    const alpha = packument("alpha", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    const beta = packument("beta", [
      { version: "2.0.0", publishedAt: "2024-02-01T00:00:00.000Z" },
    ]);
    const { fetchImpl, requested } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=41&limit=100`,
          jsonResponse({
            results: [
              { seq: 42, id: "alpha" },
              { seq: 43, id: "_design/views" },
              { seq: 44, id: "beta" },
              { seq: 45, id: "alpha" },
            ],
            last_seq: 45,
          }),
        ],
        [`${REGISTRY}/alpha`, jsonResponse(alpha)],
        [`${REGISTRY}/beta`, jsonResponse(beta)],
      ]),
    );

    const result = await collectReleases("41", { fetchImpl });

    expect(result.candidates.map((item) => item.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.candidates.map((item) => item.version)).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
    expect(result.nextSince).toBe("45");
    expect(
      requested.filter((url) => url.startsWith(`${REGISTRY}/`)),
    ).toHaveLength(2);
  });

  it("skips an id with a lone surrogate between two valid packages", async () => {
    const alpha = packument("alpha", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    const beta = packument("beta", [
      { version: "2.0.0", publishedAt: "2024-02-01T00:00:00.000Z" },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=10&limit=100`,
          jsonResponse({
            results: [
              { seq: 11, id: "alpha" },
              { seq: 12, id: "\ud800" },
              { seq: 13, id: "beta" },
            ],
            last_seq: 13,
          }),
        ],
        [`${REGISTRY}/alpha`, jsonResponse(alpha)],
        [`${REGISTRY}/beta`, jsonResponse(beta)],
      ]),
    );

    const result = await collectReleases("10", { fetchImpl });

    expect(result.candidates.map((item) => item.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("<invalid-name>");
    expect(result.skipped[0]?.reason).toMatch(/not well-formed Unicode/u);
    expect(result.skipped[0]?.reason).toContain("\\ud800");
  });

  it("passes the caller's since and limit to the change feed", async () => {
    const { fetchImpl, requested } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=7&limit=5`,
          jsonResponse({ results: [], last_seq: 9 }),
        ],
      ]),
    );

    const result = await collectReleases("7", { fetchImpl, limit: 5 });

    expect(requested).toEqual([`${CHANGES}?since=7&limit=5`]);
    expect(result).toEqual({ candidates: [], nextSince: "9", skipped: [] });
  });

  it("throws CollectorError when the change feed fails", async () => {
    const { fetchImpl } = routedFetch(
      new Map([[`${CHANGES}?since=0&limit=100`, jsonResponse({}, 503)]]),
    );

    await expect(collectReleases("0", { fetchImpl })).rejects.toBeInstanceOf(
      CollectorError,
    );
  });
});

describe("candidatesForPackage", () => {
  it("uses the version published immediately before, not semver order", async () => {
    const doc = packument("@scope/pkg", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
      { version: "2.0.0", publishedAt: "2024-03-01T00:00:00.000Z" },
      { version: "1.0.1", publishedAt: "2024-04-01T00:00:00.000Z" },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/@scope%2fpkg`, jsonResponse(doc)]]),
    );

    const { candidates } = await candidatesForPackage("@scope/pkg", {
      fetchImpl,
    });

    expect(candidates.map((item) => item.version)).toEqual([
      "1.0.0",
      "2.0.0",
      "1.0.1",
    ]);
    expect(candidates[0]?.previous).toBeNull();
    expect(candidates[1]?.previous?.version).toBe("1.0.0");
    expect(candidates[2]?.previous?.version).toBe("2.0.0");
  });

  it("reports a first release with no previous version", async () => {
    const doc = packument("solo", [
      { version: "0.1.0", publishedAt: "2024-05-01T00:00:00.000Z" },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/solo`, jsonResponse(doc)]]),
    );

    const { candidates, skipped } = await candidatesForPackage("solo", {
      fetchImpl,
    });

    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      ecosystem: "npm",
      name: "solo",
      version: "0.1.0",
      previous: null,
      publishedAt: "2024-05-01T00:00:00.000Z",
    });
  });

  it("reports missing integrity, sha1-only integrity and a foreign tarball origin", async () => {
    const doc = packument("mixed", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
      {
        version: "1.0.1",
        publishedAt: "2024-02-01T00:00:00.000Z",
        integrity: null,
      },
      {
        version: "1.0.2",
        publishedAt: "2024-03-01T00:00:00.000Z",
        integrity: "sha1-deadbeef",
      },
      {
        version: "1.0.3",
        publishedAt: "2024-04-01T00:00:00.000Z",
        tarball: "https://elsewhere.example/mixed-1.0.3.tgz",
      },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/mixed`, jsonResponse(doc)]]),
    );

    const { candidates, skipped } = await candidatesForPackage("mixed", {
      fetchImpl,
    });

    expect(candidates.map((item) => item.version)).toEqual(["1.0.0"]);
    expect(skipped).toHaveLength(3);
    expect(skipped.map((item) => item.name)).toEqual([
      "mixed",
      "mixed",
      "mixed",
    ]);
    expect(skipped[0]?.reason).toMatch(/integrity/u);
    expect(skipped[1]?.reason).toMatch(/sha512/u);
    expect(skipped[2]?.reason).toMatch(/origin/u);
  });

  it("rejects a tarball whose protocol differs from the registry", async () => {
    const doc = packument("downgrade", [
      {
        version: "1.0.0",
        publishedAt: "2024-01-01T00:00:00.000Z",
        tarball: "http://registry.npmjs.org/downgrade/-/1.0.0.tgz",
      },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/downgrade`, jsonResponse(doc)]]),
    );

    const { candidates, skipped } = await candidatesForPackage("downgrade", {
      fetchImpl,
    });

    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/origin/u);
  });

  it("rejects a tarball URL that carries credentials", async () => {
    const doc = packument("credentialed", [
      {
        version: "1.0.0",
        publishedAt: "2024-01-01T00:00:00.000Z",
        tarball:
          "https://user:secret@registry.npmjs.org/credentialed/-/1.0.0.tgz",
      },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/credentialed`, jsonResponse(doc)]]),
    );

    const { candidates, skipped } = await candidatesForPackage("credentialed", {
      fetchImpl,
    });

    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/credentials/u);
  });

  it("reports an oversized packument while other packages still collect", async () => {
    const big = packument("big", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    (big as { description: string }).description = "x".repeat(4000);
    const small = packument("small", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=1&limit=100`,
          jsonResponse({
            results: [
              { seq: 2, id: "big" },
              { seq: 3, id: "small" },
            ],
            last_seq: 3,
          }),
        ],
        [`${REGISTRY}/big`, jsonResponse(big)],
        [`${REGISTRY}/small`, jsonResponse(small)],
      ]),
    );

    const result = await collectReleases("1", {
      fetchImpl,
      maxPackumentBytes: 800,
    });

    expect(result.candidates.map((item) => item.name)).toEqual(["small"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("big");
    expect(result.skipped[0]?.reason).toMatch(/exceeds 800 bytes/u);
  });

  it("restricts candidates to onlyVersions but still finds the previous release", async () => {
    const doc = packument("picky", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
      { version: "1.0.1", publishedAt: "2024-02-01T00:00:00.000Z" },
      { version: "2.0.0", publishedAt: "2024-03-01T00:00:00.000Z" },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/picky`, jsonResponse(doc)]]),
    );

    const { candidates } = await candidatesForPackage(
      "picky",
      { fetchImpl },
      new Set(["1.0.0", "2.0.0"]),
    );

    expect(candidates.map((item) => item.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(candidates[1]?.previous?.version).toBe("1.0.1");
  });

  it("skips malformed packuments and versions without a publish time", async () => {
    const malformed = routedFetch(
      new Map([[`${REGISTRY}/broken`, jsonResponse({ name: "broken" })]]),
    );
    const bad = await candidatesForPackage("broken", {
      fetchImpl: malformed.fetchImpl,
    });
    expect(bad.candidates).toEqual([]);
    expect(bad.skipped[0]?.reason).toMatch(/no versions/u);

    const noTime = packument("timeless", []);
    (noTime as { versions: Record<string, unknown> }).versions["1.0.0"] = {
      dist: {
        integrity: "sha512-AAAA",
        tarball: `${REGISTRY}/timeless/-/1.0.0.tgz`,
      },
    };
    const timeless = routedFetch(
      new Map([[`${REGISTRY}/timeless`, jsonResponse(noTime)]]),
    );
    const missing = await candidatesForPackage("timeless", {
      fetchImpl: timeless.fetchImpl,
    });
    expect(missing.candidates).toEqual([]);
    expect(missing.skipped[0]?.reason).toMatch(/publish time/u);
  });

  it("rejects invalid package names without a request", async () => {
    const fetchImpl: typeof fetch = () => {
      throw new Error("the collector must not request an invalid name");
    };
    const names = [
      "a".repeat(215),
      "../escape",
      "has space",
      "line\nbreak",
      "\ud800",
      "",
    ];

    for (const name of names) {
      const { candidates, skipped } = await candidatesForPackage(name, {
        fetchImpl,
      });
      expect(candidates).toEqual([]);
      expect(skipped).toHaveLength(1);
    }

    let attempted = 0;
    const countingFetch: typeof fetch = () => {
      attempted += 1;
      throw new Error("stop after the request is attempted");
    };
    const longest = await candidatesForPackage("a".repeat(214), {
      fetchImpl: countingFetch,
    });
    expect(attempted).toBe(1);
    expect(longest.skipped[0]?.reason).toMatch(/request failed/u);
  });

  it("reports a 300-character name in the reason, not as an identity", async () => {
    const name = "a".repeat(300);
    const fetchImpl: typeof fetch = () => {
      throw new Error("the collector must not request an invalid name");
    };

    const { candidates, skipped } = await candidatesForPackage(name, {
      fetchImpl,
    });

    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.name).toBe("<invalid-name>");
    expect(skipped[0]?.reason).toMatch(/exceeds 214 characters/u);
    expect(skipped[0]?.reason).toContain("a".repeat(100));
    expect(skipped[0]?.reason).not.toContain(name);
  });

  it("keeps two long names that share a 200-character prefix distinct", async () => {
    const prefix = "a".repeat(160);
    const first = `${prefix}${"b".repeat(40)}`;
    const second = `${prefix}${"c".repeat(40)}`;
    const { fetchImpl } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=0&limit=100`,
          jsonResponse({
            results: [
              { seq: 1, id: first },
              { seq: 2, id: second },
            ],
            last_seq: 2,
          }),
        ],
        [
          `${REGISTRY}/${first}`,
          jsonResponse(
            packument(first, [
              { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
            ]),
          ),
        ],
        [
          `${REGISTRY}/${second}`,
          jsonResponse(
            packument(second, [
              { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
            ]),
          ),
        ],
      ]),
    );

    const { candidates } = await collectReleases("0", { fetchImpl });

    expect(candidates.map((item) => item.name)).toEqual([first, second]);
    expect(new Set(candidates.map((item) => item.name)).size).toBe(2);
  });

  it("rejects invalid version keys and keeps valid versions verbatim", async () => {
    const doc = packument("keys", [
      { version: "", publishedAt: "2024-01-01T00:00:00.000Z" },
      { version: "../../escape", publishedAt: "2024-02-01T00:00:00.000Z" },
      { version: "\ud800", publishedAt: "2024-02-15T00:00:00.000Z" },
      { version: "1.0.0", publishedAt: "2024-03-01T00:00:00.000Z" },
      {
        version: "2.0.0-rc.1+build.5",
        publishedAt: "2024-04-01T00:00:00.000Z",
      },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/keys`, jsonResponse(doc)]]),
    );

    const { candidates, skipped } = await candidatesForPackage("keys", {
      fetchImpl,
    });

    expect(candidates.map((item) => item.version)).toEqual([
      "1.0.0",
      "2.0.0-rc.1+build.5",
    ]);
    expect(skipped).toHaveLength(3);
    expect(skipped.every((item) => item.name === "keys")).toBe(true);
    const reasons = skipped.map((item) => item.reason).join("\n");
    expect(reasons).toMatch(/is empty/u);
    expect(reasons).toMatch(/not well-formed Unicode/u);
    expect(reasons).toContain(JSON.stringify("../../escape"));
    expect(reasons).toContain("\\ud800");
  });

  it("asks for the full packument, refuses redirects and bounds the request", async () => {
    const doc = packument("plan", [
      { version: "1.0.0", publishedAt: "2024-01-01T00:00:00.000Z" },
    ]);
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      requests.push({ url: requestedUrl(input), init });
      return Promise.resolve(jsonResponse(doc));
    };

    await candidatesForPackage("plan", { fetchImpl, timeoutMs: 1234 });

    const request = requests[0];
    expect(request?.url).toBe(`${REGISTRY}/plan`);
    expect(request?.init?.redirect).toBe("error");
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.init?.headers).toBeUndefined();
  });
});

describe("CollectorOptions", () => {
  it("rejects a registry that is not https or loopback http", async () => {
    const { fetchImpl } = routedFetch(new Map());
    for (const registryUrl of [
      "http://example.com",
      "ftp://registry.example",
    ]) {
      await expect(
        candidatesForPackage("pkg", { fetchImpl, registryUrl }),
      ).rejects.toBeInstanceOf(CollectorError);
    }
  });

  it("accepts loopback http for tests", async () => {
    const doc = packument("pkg", [
      {
        version: "1.0.0",
        publishedAt: "2024-01-01T00:00:00.000Z",
        tarball: "http://127.0.0.1:8080/pkg/-/1.0.0.tgz",
      },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([["http://127.0.0.1:8080/pkg", jsonResponse(doc)]]),
    );

    const { candidates } = await candidatesForPackage("pkg", {
      fetchImpl,
      registryUrl: "http://127.0.0.1:8080",
    });

    expect(candidates.map((item) => item.version)).toEqual(["1.0.0"]);
  });
});

describe("collectReleases failure accounting", () => {
  it("reports a packument that returns HTTP 500 and keeps the other packages", async () => {
    const beta = packument("beta", [
      { version: "2.0.0", publishedAt: "2024-02-01T00:00:00.000Z" },
    ]);
    const { fetchImpl } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=3&limit=100`,
          jsonResponse({
            results: [
              { seq: 4, id: "alpha" },
              { seq: 5, id: "beta" },
            ],
            last_seq: 5,
          }),
        ],
        [`${REGISTRY}/alpha`, jsonResponse({ error: "boom" }, 500)],
        [`${REGISTRY}/beta`, jsonResponse(beta)],
      ]),
    );

    const result = await collectReleases("3", { fetchImpl });

    expect(result.candidates.map((item) => item.name)).toEqual(["beta"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("alpha");
    expect(result.skipped[0]?.reason).toMatch(/HTTP 500/u);
  });

  it("survives a packument with 150000 invalid version keys", async () => {
    const versions: Record<string, unknown> = {};
    for (let index = 0; index < 150_000; index += 1) {
      versions[`bad-${String(index)}`] = {};
    }
    const { fetchImpl } = routedFetch(
      new Map([
        [
          `${CHANGES}?since=3&limit=100`,
          jsonResponse({ results: [{ seq: 4, id: "huge" }], last_seq: 4 }),
        ],
        [
          `${REGISTRY}/huge`,
          jsonResponse({ name: "huge", versions, time: {} }),
        ],
      ]),
    );

    const result = await collectReleases("3", { fetchImpl });

    expect(result.nextSince).toBe("4");
    expect(result.candidates).toEqual([]);
    expect(result.skipped.length).toBeLessThanOrEqual(101);
    expect(result.skipped.at(-1)?.reason).toMatch(/more skipped entries/u);
  });

  it("queues only the 20 newest of many valid versions", async () => {
    const items: FixtureVersion[] = [];
    for (let index = 0; index < 5000; index += 1) {
      items.push({
        version: `1.0.${String(index)}`,
        publishedAt: new Date(
          Date.UTC(2020, 0, 1) + index * 60_000,
        ).toISOString(),
      });
    }
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/many`, jsonResponse(packument("many", items))]]),
    );

    const result = await candidatesForPackage("many", { fetchImpl });

    expect(result.candidates).toHaveLength(20);
    expect(result.candidates.at(-1)?.version).toBe("1.0.4999");
    expect(result.candidates[0]?.version).toBe("1.0.4980");
    expect(result.candidates[0]?.previous?.version).toBe("1.0.4979");
    expect(result.skipped.at(-1)?.reason).toBe(
      "4980 older versions not queued",
    );
  });

  it("still returns an old version that onlyVersions names", async () => {
    const items: FixtureVersion[] = [];
    for (let index = 0; index < 50; index += 1) {
      items.push({
        version: `1.0.${String(index)}`,
        publishedAt: new Date(
          Date.UTC(2020, 0, 1) + index * 60_000,
        ).toISOString(),
      });
    }
    const { fetchImpl } = routedFetch(
      new Map([[`${REGISTRY}/many`, jsonResponse(packument("many", items))]]),
    );

    const result = await candidatesForPackage(
      "many",
      { fetchImpl },
      new Set(["1.0.3"]),
    );

    expect(result.candidates.map((item) => item.version)).toEqual(["1.0.3"]);
    expect(result.skipped).toEqual([]);
  });

  it("throws CollectorError for a change feed that is not the expected JSON", async () => {
    const { fetchImpl } = routedFetch(
      new Map([[`${CHANGES}?since=0&limit=100`, new Response("not json")]]),
    );

    await expect(collectReleases("0", { fetchImpl })).rejects.toBeInstanceOf(
      CollectorError,
    );

    const noResults = routedFetch(
      new Map([
        [`${CHANGES}?since=0&limit=100`, jsonResponse({ last_seq: 1 })],
      ]),
    );
    await expect(
      collectReleases("0", { fetchImpl: noResults.fetchImpl }),
    ).rejects.toBeInstanceOf(CollectorError);
  });
});
