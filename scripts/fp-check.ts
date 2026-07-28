import { analyzeChangedPackages } from "../src/core/manifest-analysis-pipeline.js";
import type { ChangedPackage } from "../src/core/contract/lockfile-diff.js";
import type { FindingSeverity } from "../src/core/capability-differ.js";
import { pathToFileURL } from "node:url";

const DEFAULT_BUMPS = 3;
const MAX_BUMPS = 20;
const MAX_PACKAGES = 100;
const METADATA_TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 20 * 1024 * 1024;

interface RegistryVersion {
  version: string;
  tarball: string;
  integrity: string;
}

interface BumpSummary {
  package: string;
  oldVersion: string;
  newVersion: string;
  status: "analyzed" | "unavailable";
  findings: number;
  diagnostics: number;
  bySeverity: Record<FindingSeverity, number>;
  error: string | null;
}

interface ParsedArguments {
  packages: readonly string[];
  bumps: number;
}

async function main(): Promise<void> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error: unknown) {
    process.stderr.write(
      `${errorMessage(error)}\nUsage: npm run fp-check -- --bumps 3 package-a @scope/package-b\n`,
    );
    process.exitCode = 64;
    return;
  }

  const summaries: BumpSummary[] = [];
  const packageErrors: { package: string; error: string }[] = [];
  for (const packageName of parsed.packages) {
    try {
      const versions = await recentVersions(packageName, parsed.bumps + 1);
      if (versions.length < 2) {
        packageErrors.push({
          package: packageName,
          error: "fewer than two eligible releases",
        });
        continue;
      }
      const pairs = versions.slice(1).map((newest, index) => {
        const previous = versions[index];
        if (previous === undefined)
          throw new Error("version-pair construction failed");
        return changedPackage(packageName, previous, newest);
      });
      const run = await analyzeChangedPackages({
        changed: pairs,
        findings: [],
        skipped: [],
        firstRun: false,
      });
      for (let index = 0; index < pairs.length; index += 1) {
        const pair = pairs[index];
        const result = run.packages[index];
        if (pair === undefined || result === undefined)
          throw new Error("analysis result order mismatch");
        if (result.status === "unavailable") {
          summaries.push({
            package: packageName,
            oldVersion: pair.oldVersion ?? "",
            newVersion: pair.newVersion,
            status: "unavailable",
            findings: 0,
            diagnostics: 0,
            bySeverity: emptySeverities(),
            error: result.failures
              .map((failure) => `${failure.stage}: ${failure.failure.detail}`)
              .join("; "),
          });
          continue;
        }
        const bySeverity = emptySeverities();
        for (const finding of result.diff.findings)
          bySeverity[finding.severity] += 1;
        summaries.push({
          package: packageName,
          oldVersion: pair.oldVersion ?? "",
          newVersion: pair.newVersion,
          status: "analyzed",
          findings: result.diff.findings.length,
          diagnostics: result.diff.diagnostics.length,
          bySeverity,
          error: null,
        });
      }
    } catch (error: unknown) {
      packageErrors.push({ package: packageName, error: errorMessage(error) });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        selection:
          "adjacent highest nondeprecated stable npm releases; not a legitimacy attestation",
        requestedBumps: parsed.bumps,
        packages: parsed.packages,
        summary: {
          bumps: summaries.length,
          analyzed: summaries.filter((item) => item.status === "analyzed")
            .length,
          unavailable: summaries.filter((item) => item.status === "unavailable")
            .length,
          findings: summaries.reduce((total, item) => total + item.findings, 0),
        },
        bumps: summaries,
        packageErrors,
      },
      null,
      2,
    )}\n`,
  );
  if (
    packageErrors.length > 0 ||
    summaries.some((item) => item.status === "unavailable")
  )
    process.exitCode = 2;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  let bumps = DEFAULT_BUMPS;
  const packages: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--bumps") {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/u.test(value))
        throw new Error("--bumps requires an integer");
      bumps = Number(value);
      index += 1;
    } else if (argument?.startsWith("--") === true) {
      throw new Error(`unknown option ${argument}`);
    } else if (argument !== undefined) {
      packages.push(argument);
    }
  }
  if (!Number.isSafeInteger(bumps) || bumps <= 0 || bumps > MAX_BUMPS)
    throw new Error(`--bumps must be between 1 and ${String(MAX_BUMPS)}`);
  if (packages.length === 0 || packages.length > MAX_PACKAGES)
    throw new Error(
      `provide between 1 and ${String(MAX_PACKAGES)} package names`,
    );
  for (const name of packages) {
    if (!/^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/u.test(name))
      throw new Error(`invalid npm package name ${JSON.stringify(name)}`);
  }
  return { packages, bumps };
}

async function recentVersions(
  packageName: string,
  count: number,
): Promise<RegistryVersion[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, METADATA_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
      {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: controller.signal,
      },
    );
    if (!response.ok || response.body === null)
      throw new Error(
        `registry metadata returned HTTP ${String(response.status)}`,
      );
    const bytes = await readCapped(response.body, MAX_METADATA_BYTES);
    const metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
    if (!isRecord(metadata) || !isRecord(metadata.versions))
      throw new Error("registry metadata has an invalid shape");
    const versions: RegistryVersion[] = [];
    for (const [version, raw] of Object.entries(metadata.versions)) {
      if (
        !/^\d+\.\d+\.\d+$/u.test(version) ||
        !isRecord(raw) ||
        raw.deprecated !== undefined ||
        !isRecord(raw.dist)
      )
        continue;
      if (
        typeof raw.dist.tarball !== "string" ||
        typeof raw.dist.integrity !== "string" ||
        !raw.dist.integrity.startsWith("sha512-")
      )
        continue;
      versions.push({
        version,
        tarball: raw.dist.tarball,
        integrity: raw.dist.integrity,
      });
    }
    versions.sort((left, right) =>
      compareStableVersions(left.version, right.version),
    );
    return versions.slice(-count);
  } finally {
    clearTimeout(timeout);
  }
}

function compareStableVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("metadata size limit");
      throw new Error(`registry metadata exceeds ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function changedPackage(
  name: string,
  previous: RegistryVersion,
  newest: RegistryVersion,
): ChangedPackage {
  return {
    name,
    oldVersion: previous.version,
    newVersion: newest.version,
    oldIntegrity: previous.integrity,
    newIntegrity: newest.integrity,
    oldResolvedUrl: previous.tarball,
    resolvedUrl: newest.tarball,
  };
}

function emptySeverities(): Record<FindingSeverity, number> {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
