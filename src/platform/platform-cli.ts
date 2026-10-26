import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { MAX_VALUE_CHARS, truncate } from "../core/report-builder.js";
import { createApiServer, listenApi } from "./api.js";
import {
  generateToken,
  hashToken,
  parseReviewersFile,
  ReviewersError,
  validateReviewerName,
  type Reviewers,
} from "./intel/reviewers.js";
import type { CollectorOptions } from "./registry-collector.js";
import { analyzeOne, monitorOnce, openService } from "./service.js";
import { readWatchlist, WatchlistError } from "./watchlist.js";
import { MAX_CONCURRENCY } from "./worker.js";

export interface PlatformCliIo {
  stdout(s: string): void;
  stderr(s: string): void;
  signal?: AbortSignal;
  /** Injected only so tests can drive the interval loop without waiting. */
  delay?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

type CommandOptions = NonNullable<ParseArgsConfig["options"]>;

const USAGE = [
  "usage: capdelta-platform <command> [options]",
  "",
  "Commands:",
  "  monitor --data <dir> [--interval <seconds>] [--concurrency <n>] [--page-size <n>] [--registry <url>] [--changes <url>] [--watchlist <file>]",
  "      Run one monitor cycle, or repeat every interval until stopped.",
  "  analyze --data <dir> --package <name> --version <version> [--concurrency <n>] [--registry <url>]",
  "      Analyze one release now, without the change feed.",
  "  serve --data <dir> [--port <port>] [--host <host>] [--reviewers <file>]",
  "      Serve stored releases and jobs over HTTP. With --reviewers, also",
  "      accept reviewer-authenticated transitions.",
  "  reviewer-token --name <name>",
  "      Print a new reviewer token and the reviewers-file entry for it. The",
  "      token is shown once; the command writes no file.",
  "",
  "Options:",
  "  --help  Print this help.",
].join("\n");

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const CONCURRENCY_USAGE = `--concurrency must be an integer between 1 and ${String(MAX_CONCURRENCY)}`;
const MAX_PAGE_SIZE = 1000;
const PAGE_SIZE_USAGE = `--page-size must be an integer between 1 and ${String(MAX_PAGE_SIZE)}`;

export async function runPlatformCli(
  argv: string[],
  io: PlatformCliIo,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  if (command === "monitor") return runMonitor(rest, io);
  if (command === "analyze") return runAnalyze(rest, io);
  if (command === "serve") return runServe(rest, io);
  if (command === "reviewer-token") return runReviewerToken(rest, io);
  if (command === undefined) return usageError(io, "no command given");
  return usageError(
    io,
    `unknown command ${JSON.stringify(truncate(command, MAX_VALUE_CHARS))}`,
  );
}

async function runMonitor(args: string[], io: PlatformCliIo): Promise<number> {
  const parsed = parse(args, {
    data: { type: "string" },
    interval: { type: "string" },
    concurrency: { type: "string" },
    "page-size": { type: "string" },
    registry: { type: "string" },
    changes: { type: "string" },
    watchlist: { type: "string" },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  const data = requireData(parsed.values, "monitor");
  if (!data.ok) return usageError(io, data.message);
  const seconds = parseInterval(parsed.values.interval);
  if (seconds === null) {
    return usageError(io, "--interval must be a positive number of seconds");
  }
  const concurrency = parseConcurrency(parsed.values.concurrency);
  if (concurrency === null) return usageError(io, CONCURRENCY_USAGE);
  const pageSize = parsePageSize(parsed.values["page-size"]);
  if (pageSize === null) return usageError(io, PAGE_SIZE_USAGE);
  let watchlist: ReadonlyMap<string, number> | undefined;
  if (parsed.values.watchlist !== undefined) {
    try {
      watchlist = await readWatchlist(parsed.values.watchlist);
    } catch (error: unknown) {
      // A watchlist that cannot be read stops the monitor; it never falls
      // back to watching every feed id (ADR-047).
      if (error instanceof WatchlistError) {
        return usageError(io, error.message);
      }
      throw error;
    }
  }
  const collector = monitorCollector(parsed.values, pageSize, watchlist);
  const config = {
    dataDir: data.data,
    collector,
    ...(concurrency === undefined ? {} : { concurrency }),
    onEvent: (message: string) => {
      io.stderr(`${message}\n`);
    },
  };

  const cycle = async (): Promise<boolean> => {
    const result = await monitorOnce(config);
    io.stdout(
      `monitor: enqueued ${String(result.enqueued)}, skipped ${String(result.skipped)}, unlisted ${String(result.unlisted ?? 0)}, analyzed ${String(result.done)}, failed ${String(result.failed)}, cursor ${result.cursor}${result.behind ? ", behind" : ""}\n`,
    );
    return result.behind;
  };

  if (seconds === undefined) {
    try {
      await cycle();
      return 0;
    } catch (error) {
      return failure(io, error);
    }
  }

  for (;;) {
    if (io.signal?.aborted === true) return 0;
    let behind: boolean;
    try {
      behind = await cycle();
    } catch (error) {
      return failure(io, error);
    }
    // A full page means the feed may hold more, so read the next page now.
    if (behind) continue;
    try {
      await waitInterval(io, seconds * 1000);
    } catch (error) {
      if (isAbort(error)) return 0;
      return failure(io, error);
    }
  }
}

async function runAnalyze(args: string[], io: PlatformCliIo): Promise<number> {
  const parsed = parse(args, {
    data: { type: "string" },
    package: { type: "string" },
    version: { type: "string" },
    concurrency: { type: "string" },
    registry: { type: "string" },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  const data = requireData(parsed.values, "analyze");
  if (!data.ok) return usageError(io, data.message);
  const name = parsed.values.package;
  if (name === undefined) return usageError(io, "analyze requires --package");
  const version = parsed.values.version;
  if (version === undefined) {
    return usageError(io, "analyze requires --version");
  }
  const concurrency = parseConcurrency(parsed.values.concurrency);
  if (concurrency === null) return usageError(io, CONCURRENCY_USAGE);

  try {
    const result = await analyzeOne(
      {
        dataDir: data.data,
        collector: collectorOptions(parsed.values),
        ...(concurrency === undefined ? {} : { concurrency }),
      },
      name,
      version,
    );
    io.stdout(
      `analyze: analyzed ${String(result.done)}, failed ${String(result.failed)}\n`,
    );
    return 0;
  } catch (error) {
    return failure(io, error);
  }
}

async function runServe(args: string[], io: PlatformCliIo): Promise<number> {
  const parsed = parse(args, {
    data: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    reviewers: { type: "string" },
  });
  if (!parsed.ok) return usageError(io, parsed.message);
  const data = requireData(parsed.values, "serve");
  if (!data.ok) return usageError(io, data.message);
  const port = parsePort(parsed.values.port);
  if (port === null) {
    return usageError(io, "--port must be an integer between 0 and 65535");
  }
  const host = parsed.values.host ?? DEFAULT_HOST;

  let reviewers: Reviewers | undefined;
  if (parsed.values.reviewers !== undefined) {
    try {
      reviewers = parseReviewersFile(
        await readFile(parsed.values.reviewers, "utf8"),
      );
    } catch (error) {
      return failure(io, error);
    }
  }

  const handles = openService({ dataDir: data.data, collector: {} });
  const server = createApiServer({
    releases: handles.releases,
    findings: handles.findings,
    queue: handles.queue,
    ...(reviewers === undefined ? {} : { reviewers }),
  });

  try {
    const address = await listenApi(server, port, host);
    io.stdout(`listening on ${address.host}:${String(address.port)}\n`);
  } catch (error) {
    return failure(io, error);
  }

  // Without a signal the caller owns the server; the listening socket keeps
  // the process alive.
  await waitForAbort(io.signal);
  try {
    await closeServer(server);
    return 0;
  } catch (error) {
    return failure(io, error);
  }
}

function runReviewerToken(args: string[], io: PlatformCliIo): number {
  const parsed = parse(args, { name: { type: "string" } });
  if (!parsed.ok) return usageError(io, parsed.message);
  const raw = parsed.values.name;
  if (raw === undefined) {
    return usageError(io, "reviewer-token requires --name <name>");
  }

  let name: string;
  try {
    name = validateReviewerName(raw);
  } catch (error) {
    if (error instanceof ReviewersError) return usageError(io, error.message);
    throw error;
  }

  const token = generateToken();
  io.stdout(
    `${token}\n${JSON.stringify(hashToken(token))}: ${JSON.stringify(name)}\n`,
  );
  return 0;
}

interface ParseOk {
  ok: true;
  values: Record<string, string | undefined>;
}

interface ParseFail {
  ok: false;
  message: string;
}

function parse(args: string[], options: CommandOptions): ParseOk | ParseFail {
  try {
    const parsed = parseArgs({
      args,
      options,
      allowPositionals: false,
      strict: true,
    });
    // Every option this CLI declares is type "string"; the cast narrows the
    // wider union that parseArgs infers from a passed-in option map.
    return {
      ok: true,
      values: parsed.values as Record<string, string | undefined>,
    };
  } catch (error) {
    if (error instanceof TypeError)
      return { ok: false, message: error.message };
    throw error;
  }
}

/** Returns the --data value, or the usage message when it is missing. */
function requireData(
  values: Record<string, string | undefined>,
  command: string,
): { ok: true; data: string } | { ok: false; message: string } {
  const data = values.data;
  if (data === undefined) {
    return { ok: false, message: `${command} requires --data <dir>` };
  }
  return { ok: true, data };
}

function parseInterval(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds;
}

function parseConcurrency(
  value: string | undefined,
): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) return null;
  const concurrency = Number(value);
  return concurrency >= 1 && concurrency <= MAX_CONCURRENCY
    ? concurrency
    : null;
}

function parsePageSize(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) return null;
  const pageSize = Number(value);
  return pageSize >= 1 && pageSize <= MAX_PAGE_SIZE ? pageSize : null;
}

function parsePort(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/u.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

function collectorOptions(
  values: Record<string, string | undefined>,
): CollectorOptions {
  const options: CollectorOptions = {};
  if (values.registry !== undefined) options.registryUrl = values.registry;
  if (values.changes !== undefined) options.changesUrl = values.changes;
  return options;
}

function monitorCollector(
  values: Record<string, string | undefined>,
  pageSize: number | undefined,
  watchlist: ReadonlyMap<string, number> | undefined,
): CollectorOptions {
  const collector = collectorOptions(values);
  if (pageSize !== undefined) collector.limit = pageSize;
  if (watchlist !== undefined) collector.watchlist = watchlist;
  return collector;
}

function signalOption(
  signal: AbortSignal | undefined,
): { signal: AbortSignal } | Record<string, never> {
  return signal === undefined ? {} : { signal };
}

function waitInterval(io: PlatformCliIo, ms: number): Promise<void> {
  if (io.delay !== undefined) return io.delay(ms, io.signal);
  return delay(ms, undefined, signalOption(io.signal));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function usageError(io: PlatformCliIo, message: string): number {
  io.stderr(
    `${truncate(message.replace(/\s+/gu, " "), MAX_VALUE_CHARS)}\n${USAGE}\n`,
  );
  return 2;
}

function failure(io: PlatformCliIo, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(
    `error: ${truncate(message.replace(/\s+/gu, " "), MAX_VALUE_CHARS)}\n`,
  );
  return 1;
}
