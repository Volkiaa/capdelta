import { isIP } from "node:net";
import type {
  Evidence,
  EvidenceList,
  ObfuscationPattern,
  SignalEndpointContext,
  SignalEndpointObservation,
  SignalFileObservation,
  SignalObfuscationObservation,
  SignalParseState,
  SignalSet,
} from "./contract/capability-set.js";
import { compareEvidence, compareText } from "./compare.js";
import { lineIndexAt, lineStarts } from "./line-index.js";

/** Provisional thresholds; PLAN §4.4 leaves corpus tuning to validation. */
export const MIN_ENTROPY_BYTES = 256 as const;
export const ENTROPY_JUMP_MILLIBITS = 1_000 as const;
export const HIGH_ENTROPY_MILLIBITS = 6_500 as const;
export const MIN_OBFUSCATION_ARRAY_ELEMENTS = 8 as const;

const MAX_EVIDENCE_SNIPPET = 240;
const URL_LITERAL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/gu;
const IP_LITERAL_ROWS = [
  {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
    family: 4,
    endpointType: "ipv4",
    lowercase: false,
  },
  {
    pattern: /(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}/giu,
    family: 6,
    endpointType: "ipv6",
    lowercase: true,
  },
] as const;
const ARRAY_RE = /\x5b([^\x5b\x5d]{1,4096})\x5d/gu;
const HEX_ELEMENT_RE = /^0x[0-9a-f]{1,2}$/iu;
const CHARCODE_ELEMENT_RE = /^\d{1,3}$/u;

export interface SignalSourceInput {
  file: string;
  bytes: Uint8Array;
  parseState: SignalParseState;
  /**
   * Comment ranges from a successful parse of these exact bytes, as half-open
   * UTF-16 offsets. Only applied when parseState is "parsed"; absent means no
   * exclusion, never "comment-free".
   */
  commentRanges?: readonly (readonly [number, number])[];
  /**
   * Content ranges of parsed string literals and template elements, as
   * half-open UTF-16 offsets excluding quotes and backticks. Only applied when
   * parseState is "parsed"; absent means every URL is "unknown".
   */
  stringRanges?: readonly (readonly [number, number])[];
}

export function emptySignalSet(): SignalSet {
  return { sourceFiles: [], endpoints: [], obfuscationPatterns: [] };
}

/**
 * Extracts bounded lexical signals from one source file. It never executes or
 * parses code and therefore remains useful when the AST parser rejects bytes.
 */
export function observeSignalSource(input: SignalSourceInput): {
  file: SignalFileObservation;
  endpoints: readonly SignalEndpointObservation[];
  obfuscationPatterns: readonly SignalObfuscationObservation[];
} {
  const source = new TextDecoder("utf-8").decode(input.bytes);
  const starts = lineStarts(source);
  const confidence =
    input.parseState === "parsed" ? "literal" : "byte-scan-candidate";
  const inComment =
    input.parseState === "parsed" && input.commentRanges !== undefined
      ? commentLookup(input.file, input.commentRanges, source.length)
      : (): boolean => false;
  // Unknown is a security rule: a file the parser cannot read must never get a
  // URL demoted, so an attacker cannot gain by breaking the parse.
  const contextAt =
    input.parseState === "parsed" && input.stringRanges !== undefined
      ? contextLookup(input.file, input.stringRanges, source)
      : (): SignalEndpointContext => "unknown";
  const endpoints = detectEndpoints(
    input.file,
    source,
    starts,
    confidence,
    inComment,
    contextAt,
  );
  const obfuscationPatterns = detectObfuscationPatterns(
    input.file,
    source,
    starts,
  );
  return {
    file: {
      file: input.file,
      byteLength: input.bytes.byteLength,
      entropyMilliBitsPerByte: entropyMilliBitsPerByte(input.bytes),
      parseState: input.parseState,
    },
    endpoints,
    obfuscationPatterns,
  };
}

export function buildSignalSet(
  observations: readonly ReturnType<typeof observeSignalSource>[],
): SignalSet {
  const sourceFiles = observations.map(({ file }) => file);
  sourceFiles.sort((left, right) => compareText(left.file, right.file));

  const endpoints = mergeByKey(
    observations.flatMap(({ endpoints: found }) => found),
    (observation) =>
      JSON.stringify([observation.endpointType, observation.normalizedValue]),
    (current, next): SignalEndpointObservation => ({
      ...current,
      confidence:
        current.confidence === "literal" || next.confidence === "literal"
          ? "literal"
          : "byte-scan-candidate",
      context: strongestContext(current.context, next.context),
      evidence: mergeEvidence(current.evidence, next.evidence),
    }),
  );
  const obfuscationPatterns = mergeByKey(
    observations.flatMap(({ obfuscationPatterns: found }) => found),
    (observation) => JSON.stringify([observation.file, observation.pattern]),
    (current, next) => ({
      ...current,
      elementCount: Math.max(current.elementCount, next.elementCount),
      evidence: mergeEvidence(current.evidence, next.evidence),
    }),
  );
  return { sourceFiles, endpoints, obfuscationPatterns };
}

function detectEndpoints(
  file: string,
  source: string,
  starts: readonly number[],
  confidence: SignalEndpointObservation["confidence"],
  inComment: (start: number, end: number) => boolean,
  contextAt: (start: number) => SignalEndpointContext,
): SignalEndpointObservation[] {
  const found: SignalEndpointObservation[] = [];
  for (const match of source.matchAll(URL_LITERAL_RE)) {
    const value = match[0];
    const index = match.index;
    // Documentation links in comments are not runtime endpoints; a match that
    // runs into a comment ("https://x\n" after a label) is not one either.
    if (inComment(index, index + match[0].length)) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      continue;
    }
    const rawHost = parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, "")
      .replace(/\.$/u, "");
    const endpointType = endpointTypeFor(rawHost);
    const host =
      endpointType === "domain" ? publicStyleDomain(rawHost) : rawHost;
    if (host === null) continue;
    if (endpointType === null || !isExternalHost(host, endpointType)) continue;
    found.push(
      endpoint(
        file,
        host,
        endpointType,
        source,
        starts,
        index,
        confidence,
        contextAt(index),
      ),
    );
  }

  for (const row of IP_LITERAL_ROWS) {
    for (const match of source.matchAll(row.pattern)) {
      const value = match[0];
      const index = match.index;
      if (inComment(index, index + value.length)) continue;
      if (isIP(value) !== row.family) continue;
      if (!isExternalHost(value, row.endpointType)) continue;
      found.push(
        endpoint(
          file,
          row.lowercase ? value.toLowerCase() : value,
          row.endpointType,
          source,
          starts,
          index,
          confidence,
          // ADR-024 covers URLs only; a bare IP literal keeps today's severity.
          "unknown",
        ),
      );
    }
  }
  return found;
}

function endpoint(
  file: string,
  value: string,
  endpointType: SignalEndpointObservation["endpointType"],
  source: string,
  starts: readonly number[],
  index: number,
  confidence: SignalEndpointObservation["confidence"],
  context: SignalEndpointContext,
): SignalEndpointObservation {
  return {
    kind: "EXTERNAL_ENDPOINT",
    endpointType,
    normalizedValue: value,
    confidence,
    context,
    evidence: [{ ...evidenceAt(source, starts, index), file }],
  };
}

function detectObfuscationPatterns(
  file: string,
  source: string,
  starts: readonly number[],
): SignalObfuscationObservation[] {
  const found: SignalObfuscationObservation[] = [];
  for (const match of source.matchAll(ARRAY_RE)) {
    const body = match[1] ?? "";
    const index = match.index;
    const elements = body
      .split(",")
      .map((element) => element.trim())
      .filter((element) => element.length > 0);
    if (elements.length < MIN_OBFUSCATION_ARRAY_ELEMENTS) continue;
    const pattern = arrayPattern(elements);
    if (pattern === null) continue;
    found.push({
      kind: "OBFUSCATION_PATTERN",
      file,
      pattern,
      elementCount: elements.length,
      evidence: [{ ...evidenceAt(source, starts, index), file }],
    });
  }
  return found;
}

function arrayPattern(elements: readonly string[]): ObfuscationPattern | null {
  if (elements.every((element) => HEX_ELEMENT_RE.test(element))) {
    return "hex-byte-array";
  }
  if (
    elements.length >= MIN_OBFUSCATION_ARRAY_ELEMENTS &&
    elements.every((element) => {
      if (!CHARCODE_ELEMENT_RE.test(element)) return false;
      const value = Number(element);
      return value >= 0 && value <= 255;
    })
  ) {
    return "charcode-array";
  }
  return null;
}

/**
 * Groups items by a JSON key, merges each duplicate into the first item seen,
 * and sorts the result by the same key with the shared text comparator.
 */
function mergeByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  merge: (current: T, next: T) => T,
): T[] {
  const grouped = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    const current = grouped.get(key);
    grouped.set(key, current === undefined ? item : merge(current, item));
  }
  return [...grouped.values()].sort((left, right) =>
    compareText(keyOf(left), keyOf(right)),
  );
}

function mergeEvidence(left: EvidenceList, right: EvidenceList): EvidenceList {
  const unique = new Map<string, Evidence>();
  for (const item of [...left, ...right]) {
    unique.set(JSON.stringify([item.file, item.line, item.snippet]), item);
  }
  const sorted = [...unique.values()].sort(compareEvidence);
  const [first, ...rest] = sorted;
  if (first === undefined) {
    throw new Error("signal evidence merge produced no evidence");
  }
  return [first, ...rest];
}

function evidenceAt(
  source: string,
  starts: readonly number[],
  index: number,
): Evidence {
  const lineIndex = lineIndexAt(starts, index);
  const lineStart = starts[lineIndex] ?? 0;
  const nextLineStart = starts[lineIndex + 1] ?? source.length;
  const snippet = source
    .slice(lineStart, nextLineStart)
    .replace(/[\r\n]+$/gu, "")
    .trim()
    .slice(0, MAX_EVIDENCE_SNIPPET);
  return { file: "", line: lineIndex + 1, snippet };
}

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_DOMAIN_LENGTH = 253;

/**
 * Public-style hostname heuristic (not a DNS definition): at least two
 * labels, LDH labels, and an alphabetic or punycode TLD. It drops lexical
 * artifacts the URL parser accepts ("$addr", "fs") and narrows coverage to
 * public-looking names; single-label hosts are deliberately not reported.
 * One recovery retries after trimming trailing punctuation, so a markdown
 * link's "example.org)" becomes "example.org".
 */
function publicStyleDomain(host: string): string | null {
  if (isPublicStyleDomain(host)) return host;
  const trimmed = host.replace(/[)\]}>,.;:!?'"]+$/u, "");
  return trimmed !== host && isPublicStyleDomain(trimmed) ? trimmed : null;
}

function isPublicStyleDomain(host: string): boolean {
  if (host.length > MAX_DOMAIN_LENGTH) return false;
  const labels = host.split(".");
  const tld = labels.at(-1);
  if (labels.length < 2 || tld === undefined) return false;
  if (!labels.every((label) => DOMAIN_LABEL_RE.test(label))) return false;
  return /^[a-z]+$/u.test(tld) || /^xn--[a-z0-9-]+$/u.test(tld);
}

/**
 * Strength order for merging one host seen in several places: literal beats
 * unknown, and unknown beats embedded-text.
 */
const ENDPOINT_CONTEXT_RANK: Record<SignalEndpointContext, number> = {
  literal: 3,
  unknown: 2,
  "embedded-text": 1,
};

function strongestContext(
  left: SignalEndpointContext,
  right: SignalEndpointContext,
): SignalEndpointContext {
  return ENDPOINT_CONTEXT_RANK[right] > ENDPOINT_CONTEXT_RANK[left]
    ? right
    : left;
}

/**
 * Binary-search lookup over validated, ordered string content ranges. A match
 * that starts inside a range is "embedded-text" when the range's trimmed raw
 * content holds whitespace, meaning other words sit next to the URL, and
 * "literal" otherwise. Escape sequences such as `\n` are not whitespace in
 * the raw text, so an escape can keep a URL literal but never demote it.
 */
/**
 * A backslash before a line terminator is a JavaScript line continuation, and
 * the URL parser drops ASCII tab and newline anywhere in its input, so neither
 * separates words. Deleting them can only keep a URL literal, never demote it.
 */
function wordsOf(raw: string): string {
  return raw.replace(/\\(?:\r\n|[\n\r\u2028\u2029])|[\t\n\r]/gu, "").trim();
}

function contextLookup(
  file: string,
  ranges: readonly (readonly [number, number])[],
  source: string,
): (start: number) => SignalEndpointContext {
  let previousEnd = 0;
  for (const [start, end] of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < previousEnd ||
      end < start ||
      end > source.length
    ) {
      throw new RangeError(
        `invalid parser string ranges for ${JSON.stringify(file)}`,
      );
    }
    previousEnd = end;
  }
  return (start) => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const range = ranges[middle];
      if (range !== undefined && range[0] <= start) low = middle + 1;
      else high = middle;
    }
    const range = ranges[low - 1];
    if (range === undefined || range[1] <= start) return "unknown";
    return /\s/u.test(wordsOf(source.slice(range[0], range[1])))
      ? "embedded-text"
      : "literal";
  };
}

/**
 * Binary-search lookup over validated, ordered comment ranges, so a
 * comment-heavy source cannot make endpoint scanning quadratic.
 */
function commentLookup(
  file: string,
  ranges: readonly (readonly [number, number])[],
  sourceLength: number,
): (start: number, end: number) => boolean {
  let previousEnd = 0;
  for (const [start, end] of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < previousEnd ||
      end <= start ||
      end > sourceLength
    ) {
      throw new RangeError(
        `invalid parser comment ranges for ${JSON.stringify(file)}`,
      );
    }
    previousEnd = end;
  }
  // True when [start, end) overlaps any comment: find the first range that
  // ends after start, then check whether it begins before end.
  return (start, end) => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const range = ranges[middle];
      if (range !== undefined && range[1] <= start) low = middle + 1;
      else high = middle;
    }
    const candidate = ranges[low];
    return candidate !== undefined && candidate[0] < end;
  };
}

function endpointTypeFor(
  value: string,
): SignalEndpointObservation["endpointType"] | null {
  const family = isIP(value);
  if (family === 4) return "ipv4";
  if (family === 6) return "ipv6";
  return value.length === 0 ? null : "domain";
}

function isExternalHost(
  value: string,
  endpointType: SignalEndpointObservation["endpointType"],
): boolean {
  if (endpointType === "domain") {
    return value !== "localhost" && !value.endsWith(".localhost");
  }
  if (endpointType === "ipv4") {
    const octets = value.split(".").map(Number);
    const [first, second] = octets;
    if (first === undefined || second === undefined) return false;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  const normalized = value.toLowerCase();
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

function entropyMilliBitsPerByte(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] = (counts[byte] ?? 0) + 1;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / bytes.byteLength;
    entropy -= probability * Math.log2(probability);
  }
  return Math.round(entropy * 1_000);
}
