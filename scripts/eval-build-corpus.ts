// PLAN §7.4 phase 2: build the labeled corpus from registry state.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeChangedPackages,
  hasUnanalyzedContent,
} from "../src/core/capability-analysis-pipeline.js";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import { isRecord } from "../src/core/guards.js";
import { NamedError } from "../src/core/named-error.js";
import { diffNpmLockfiles } from "../src/core/npm/lockfile-differ.js";
import {
  MAX_IDENTITY_CHARS,
  MAX_VALUE_CHARS,
  buildRunReport,
  truncate,
} from "../src/core/report-builder.js";
import { evaluateSeverityGate } from "../src/core/run-severity.js";
import {
  assignHeldOut,
  type EvalCorpus,
  type EvalEntry,
  type ResultOverride,
} from "./eval-metrics.js";
import {
  changedPackage,
  recentVersions,
  type RegistryVersion,
} from "./fp-check.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const M5_CORPUS = join(ROOT, "docs/m5-2026-10-12/corpus.json");
const INVENTORY = join(ROOT, "test/fixtures/reconstructions/inventory.json");
const RECONSTRUCTIONS = join(ROOT, "test/fixtures/reconstructions");
const CREATED_AT = "2026-10-24T00:00:00.000Z";
const HELD_OUT_FRACTION = 0.3;
const HELD_OUT_SALT = "capdelta-eval-2026-10-24";
const BUMPS_PER_PACKAGE = 3;
const MAX_VERSIONS_PROBED = 10_000;

const M5_SOURCE =
  "assumed benign: popular package adjacent bump (m5 frozen corpus)";
const FRESH_SOURCE =
  "assumed benign: popular package adjacent bump (registry selection 2026-10-24)";

export const FRESH_PACKAGES: readonly string[] = [
  "lodash",
  "express",
  "react",
  "minimist",
  "semver",
  "rimraf",
  "glob",
  "mkdirp",
  "dotenv",
  "picocolors",
  "debug",
  "ms",
  "execa",
  "cross-env",
  "commander",
  "fs-extra",
  "cheerio",
  "marked",
  "js-yaml",
  "ajv",
  "jsonwebtoken",
  "nanoid",
  "date-fns",
  "rxjs",
  "immer",
  "postcss",
  "autoprefixer",
  "tailwindcss",
  "eslint",
  "mocha",
  "chai",
  "sinon",
  "supertest",
  "lint-staged",
  "husky",
  "esbuild",
  "sharp",
  "node-sass",
  "nodemon",
  "tsx",
  "vite",
  "pino",
  "cors",
  "tar",
  "archiver",
];

export interface MaliciousCandidate {
  name: string;
  maliciousVersion: string;
  previousVersion: string;
  source: string;
}

export const MALICIOUS_CANDIDATES: readonly MaliciousCandidate[] = [
  {
    name: "colors",
    maliciousVersion: "1.4.1",
    previousVersion: "1.4.0",
    source: "https://github.com/advisories/GHSA-gh88-3pxp-6fm8",
  },
  {
    name: "colors",
    maliciousVersion: "1.4.2",
    previousVersion: "1.4.0",
    source: "https://github.com/advisories/GHSA-5rqg-jm4f-cqx7",
  },
  {
    name: "faker",
    maliciousVersion: "6.6.6",
    previousVersion: "6.6.5",
    source: "https://github.com/advisories/GHSA-5w9c-rv96-fr7g",
  },
  {
    name: "node-ipc",
    maliciousVersion: "10.1.1",
    previousVersion: "10.1.0",
    source: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
  },
  {
    name: "node-ipc",
    maliciousVersion: "10.1.2",
    previousVersion: "10.1.0",
    source: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
  },
  {
    name: "node-ipc",
    maliciousVersion: "10.1.3",
    previousVersion: "10.1.0",
    source: "https://github.com/advisories/GHSA-97m3-w2cp-4xx6",
  },
  {
    name: "node-ipc",
    maliciousVersion: "11.0.0",
    previousVersion: "10.1.0",
    source: "https://github.com/advisories/GHSA-3mpp-xfvh-qh37",
  },
  {
    name: "event-stream",
    maliciousVersion: "3.3.6",
    previousVersion: "3.3.5",
    source: "https://github.com/advisories/GHSA-mh6f-8j2x-4483",
  },
  {
    name: "ua-parser-js",
    maliciousVersion: "0.7.29",
    previousVersion: "0.7.28",
    source: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
  },
  {
    name: "ua-parser-js",
    maliciousVersion: "0.8.0",
    previousVersion: "0.7.28",
    source: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
  },
  {
    name: "ua-parser-js",
    maliciousVersion: "1.0.0",
    previousVersion: "0.8.1",
    source: "https://github.com/advisories/GHSA-pjwm-rvh2-c87w",
  },
  {
    name: "coa",
    maliciousVersion: "2.0.3",
    previousVersion: "2.0.2",
    source: "https://github.com/advisories/GHSA-73qr-pfmq-6rp8",
  },
  {
    name: "rc",
    maliciousVersion: "1.2.9",
    previousVersion: "1.2.8",
    source: "https://github.com/advisories/GHSA-g2q5-5433-rhrf",
  },
  {
    name: "@ctrl/tinycolor",
    maliciousVersion: "4.1.1",
    previousVersion: "4.1.0",
    source:
      "https://www.stepsecurity.io/blog/ctrl-tinycolor-and-40-npm-packages-compromised",
  },
  {
    name: "@lottiefiles/lottie-player",
    maliciousVersion: "2.0.7",
    previousVersion: "2.0.4",
    source: "https://osv.dev/vulnerability/MAL-2024-10301",
  },
  {
    name: "@solana/web3.js",
    maliciousVersion: "1.95.6",
    previousVersion: "1.95.5",
    source: "https://github.com/advisories/GHSA-jcxm-7wvp-g6p5",
  },
];

export class EvalBuildError extends NamedError {}

export type EntryDraft = Omit<EvalEntry, "heldOut">;

export interface FreshSelection {
  pairs: ChangedPackage[];
  failures: { package: string; error: string }[];
}

export interface MaliciousProbe {
  candidate: MaliciousCandidate;
  status: "included" | "excluded";
  reason: string;
  pair?: ChangedPackage;
}

export function benignEntries(
  pairs: readonly ChangedPackage[],
  options: { idPrefix: string; source: string },
): EntryDraft[] {
  return pairs.map((pair) => ({
    id: `${options.idPrefix}:${truncate(pair.name, MAX_IDENTITY_CHARS)}:${truncate(pair.oldVersion ?? "none", MAX_IDENTITY_CHARS)}->${truncate(pair.newVersion, MAX_IDENTITY_CHARS)}`,
    label: "benign",
    source: options.source,
    provenance: "real-registry",
    pair,
  }));
}

export function maliciousEntries(
  included: readonly { pair: ChangedPackage; source: string }[],
): EntryDraft[] {
  return included.map(({ pair, source }) => ({
    id: `malicious:${truncate(pair.name, MAX_IDENTITY_CHARS)}:${truncate(pair.oldVersion ?? "none", MAX_IDENTITY_CHARS)}->${truncate(pair.newVersion, MAX_IDENTITY_CHARS)}`,
    label: "malicious",
    source: truncate(source, MAX_VALUE_CHARS),
    provenance: "real-registry",
    pair,
  }));
}

export function syntheticEntries(
  entries: readonly {
    id: string;
    source: string;
    resultOverride: ResultOverride;
  }[],
): EntryDraft[] {
  return entries.map((entry) => ({
    id: entry.id,
    label: "malicious",
    source: truncate(entry.source, MAX_VALUE_CHARS),
    provenance: "synthetic-reconstruction",
    resultOverride: entry.resultOverride,
  }));
}

export function assembleCorpus(
  drafts: readonly EntryDraft[],
  rule: {
    createdAt: string;
    splitRule: string;
    fraction: number;
    salt: string;
  },
): EvalCorpus {
  const seen = new Set<string>();
  for (const draft of drafts) {
    if (seen.has(draft.id))
      throw new EvalBuildError(
        `duplicate entry id ${JSON.stringify(truncate(draft.id, MAX_IDENTITY_CHARS))}`,
      );
    seen.add(draft.id);
  }
  return {
    schemaVersion: 1,
    createdAt: rule.createdAt,
    splitRule: rule.splitRule,
    entries: assignHeldOut(drafts, {
      fraction: rule.fraction,
      salt: rule.salt,
    }),
  };
}

export function choosePreviousVersion(
  versions: readonly RegistryVersion[],
  namedPrevious: string,
  maliciousVersion: string,
): RegistryVersion | undefined {
  const named = versions.find((item) => item.version === namedPrevious);
  if (
    named !== undefined &&
    compareVersions(named.version, maliciousVersion) < 0
  )
    return named;
  return versions
    .filter((item) => compareVersions(item.version, maliciousVersion) < 0)
    .at(-1);
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function selectFresh(
  packages: readonly string[],
): Promise<FreshSelection> {
  const pairs: ChangedPackage[] = [];
  const failures: { package: string; error: string }[] = [];
  for (const name of packages) {
    let versions: RegistryVersion[];
    try {
      versions = await recentVersions(name, BUMPS_PER_PACKAGE + 1);
    } catch (error: unknown) {
      failures.push({ package: name, error: describeError(error) });
      continue;
    }
    if (versions.length < 2) {
      failures.push({
        package: name,
        error: `${String(versions.length)} eligible release(s), need 2`,
      });
      continue;
    }
    for (let index = 1; index < versions.length; index += 1) {
      const previous = versions[index - 1];
      const newest = versions[index];
      if (previous === undefined || newest === undefined)
        throw new EvalBuildError(
          `version-pair construction failed for ${name}`,
        );
      pairs.push(changedPackage(name, previous, newest));
    }
  }
  return { pairs, failures };
}

async function probeMalicious(
  candidate: MaliciousCandidate,
): Promise<MaliciousProbe> {
  const versions = await registryVersions(candidate.name);
  const malicious = versions.find(
    (item) => item.version === candidate.maliciousVersion,
  );
  if (malicious === undefined)
    return {
      candidate,
      status: "excluded",
      reason:
        "version is not in the registry metadata (unpublished or replaced)",
    };
  const previous = choosePreviousVersion(
    versions,
    candidate.previousVersion,
    candidate.maliciousVersion,
  );
  if (previous === undefined)
    return {
      candidate,
      status: "excluded",
      reason: "no clean release below the malicious version remains",
    };
  const reachable = await tarballReachable(malicious.tarball);
  if (!reachable)
    return {
      candidate,
      status: "excluded",
      reason: "tarball is not reachable",
    };
  const fallback =
    previous.version === candidate.previousVersion
      ? ""
      : `; named previous ${candidate.previousVersion} is unpublished, used ${previous.version}`;
  return {
    candidate,
    status: "included",
    reason: `malicious and previous tarballs present${fallback}`,
    pair: changedPackage(candidate.name, previous, malicious),
  };
}

async function registryVersions(name: string): Promise<RegistryVersion[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await recentVersions(name, MAX_VERSIONS_PROBED);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new EvalBuildError(
    `cannot read registry metadata for ${truncate(name, MAX_IDENTITY_CHARS)}: ${describeError(lastError)}`,
    { cause: lastError },
  );
}

async function tarballReachable(url: string): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      return response.ok;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new EvalBuildError(
    `cannot reach malicious tarball ${truncate(url, MAX_VALUE_CHARS)}: ${describeError(lastError)}`,
    { cause: lastError },
  );
}

interface InventoryIncident {
  name: string;
  title: string;
  sources: readonly string[];
  scenarios: Record<
    string,
    { base: readonly string[]; head: readonly string[] }
  >;
}

async function loadInventory(): Promise<InventoryIncident[]> {
  const raw = JSON.parse(await readFile(INVENTORY, "utf8")) as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.incidents))
    throw new EvalBuildError("inventory.json: expected an incidents array");
  return raw.incidents.map((item, index) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.title !== "string" ||
      !Array.isArray(item.sources) ||
      !item.sources.every((source) => typeof source === "string") ||
      !isRecord(item.scenarios)
    )
      throw new EvalBuildError(
        `inventory.json: invalid incident at ${String(index)}`,
      );
    return item as unknown as InventoryIncident;
  });
}

async function computeSyntheticOverride(
  incident: InventoryIncident,
  scenario: "attack",
): Promise<ResultOverride> {
  const dir = join(RECONSTRUCTIONS, incident.name);
  const [base, head] = await Promise.all([
    readJson(join(dir, `${scenario}-base-lockfile.json`)),
    readJson(join(dir, `${scenario}-head-lockfile.json`)),
  ]);
  const sides = incident.scenarios[scenario];
  if (sides === undefined)
    throw new EvalBuildError(`${incident.name}: no ${scenario} scenario`);
  const bytesByIntegrity = new Map<string, Uint8Array>();
  for (const id of [...sides.base, ...sides.head]) {
    const bytes = await readFile(join(dir, "packages", `${id}.tgz`));
    bytesByIntegrity.set(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      bytes,
    );
  }
  const bytesByUrl = new Map<string, Uint8Array>();
  for (const lockfile of [base, head]) {
    if (!isRecord(lockfile) || !isRecord(lockfile.packages))
      throw new EvalBuildError(`${incident.name}: lockfile has no packages`);
    for (const entry of Object.values(lockfile.packages)) {
      if (!isRecord(entry)) continue;
      const resolved = entry.resolved;
      const integrity = entry.integrity;
      if (typeof resolved !== "string" || typeof integrity !== "string")
        continue;
      const bytes = bytesByIntegrity.get(integrity);
      if (bytes !== undefined) bytesByUrl.set(resolved, bytes);
    }
  }
  const fetchImpl: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const bytes = bytesByUrl.get(url);
    if (bytes === undefined)
      throw new EvalBuildError(
        `unexpected fixture fetch ${truncate(url, MAX_VALUE_CHARS)}`,
      );
    return Promise.resolve(
      new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      }),
    );
  };
  const run = await analyzeChangedPackages(diffNpmLockfiles(base, head), {
    fetcher: { fetchImpl },
  });
  const report = buildRunReport(run);
  const gate = evaluateSeverityGate(report, "CRITICAL");
  if (gate.fail !== report.summary.gateSeverity.CRITICAL > 0)
    throw new EvalBuildError(
      `${incident.name}: gate decision disagrees with the report`,
    );
  return {
    gateSeverity: { ...report.summary.gateSeverity },
    incomplete: hasUnanalyzedContent(run),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new EvalBuildError(
      `cannot read JSON from ${path}: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${truncate(message.replace(/\s+/gu, " "), MAX_VALUE_CHARS)}`;
}

async function build(out: string): Promise<void> {
  const m5 = await readJson(M5_CORPUS);
  if (!isRecord(m5) || !Array.isArray(m5.pairs))
    throw new EvalBuildError("m5 corpus: expected a pairs array");
  const m5Pairs = m5.pairs as ChangedPackage[];
  const overlap = FRESH_PACKAGES.filter((name) =>
    m5Pairs.some((pair) => pair.name === name),
  );
  if (overlap.length > 0)
    throw new EvalBuildError(
      `fresh packages overlap the m5 corpus: ${overlap.join(", ")}`,
    );

  const fresh = await selectFresh(FRESH_PACKAGES);
  const probes: MaliciousProbe[] = [];
  for (const candidate of MALICIOUS_CANDIDATES)
    probes.push(await probeMalicious(candidate));
  const included = probes.flatMap((probe) =>
    probe.status === "included" && probe.pair !== undefined
      ? [{ pair: probe.pair, source: probe.candidate.source }]
      : [],
  );

  const inventory = await loadInventory();
  const attacks = inventory.filter(
    (incident) => incident.scenarios.attack !== undefined,
  );
  const synthetic = [];
  for (const incident of attacks) {
    const resultOverride = await computeSyntheticOverride(incident, "attack");
    synthetic.push({
      id: `malicious:synthetic:${incident.name}/attack`,
      source: `synthetic reconstruction, not the original artifact: ${incident.sources.join(" ")}`,
      resultOverride,
    });
  }

  const drafts = [
    ...benignEntries(m5Pairs, { idPrefix: "benign:m5", source: M5_SOURCE }),
    ...benignEntries(fresh.pairs, {
      idPrefix: "benign:fresh",
      source: FRESH_SOURCE,
    }),
    ...maliciousEntries(included),
    ...syntheticEntries(synthetic),
  ];
  const corpus = assembleCorpus(drafts, {
    createdAt: CREATED_AT,
    splitRule: `held out when sha256(salt + id) is below ${String(HELD_OUT_FRACTION)} with salt ${HELD_OUT_SALT}`,
    fraction: HELD_OUT_FRACTION,
    salt: HELD_OUT_SALT,
  });
  const payload = {
    ...corpus,
    selection: {
      m5Pairs: m5Pairs.length,
      freshPackages: FRESH_PACKAGES.length,
      freshPairs: fresh.pairs.length,
      freshFailures: fresh.failures,
      maliciousCandidates: probes.map((probe) => ({
        name: probe.candidate.name,
        version: probe.candidate.maliciousVersion,
        status: probe.status,
        reason: probe.reason,
      })),
      syntheticAttacks: attacks.map((incident) => incident.name),
    },
  };
  await writeFile(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stderr.write(
    `wrote ${out}: ${String(corpus.entries.length)} entries, ${String(corpus.entries.filter((entry) => entry.label === "benign").length)} benign, ${String(corpus.entries.filter((entry) => entry.label === "malicious").length)} malicious\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const out = process.argv[2] ?? "docs/eval/2026-10-24/corpus.json";
  try {
    await build(out);
  } catch (error: unknown) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}
