import { isIP } from "node:net";
import type {
  Evidence,
  EvidenceList,
  ObfuscationPattern,
  SignalEndpointObservation,
  SignalFileObservation,
  SignalObfuscationObservation,
  SignalParseState,
  SignalSet,
} from "./contract/capability-set.js";

/** Provisional thresholds; PLAN §4.4 leaves corpus tuning to validation. */
export const MIN_ENTROPY_BYTES = 256 as const;
export const ENTROPY_JUMP_MILLIBITS = 1_000 as const;
export const HIGH_ENTROPY_MILLIBITS = 6_500 as const;
export const MIN_OBFUSCATION_ARRAY_ELEMENTS = 8 as const;

const MAX_EVIDENCE_SNIPPET = 240;
const URL_LITERAL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/gu;
const IPV4_LITERAL_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const IPV6_LITERAL_RE = /(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}/giu;
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
  const lineStarts = buildLineStarts(source);
  const confidence =
    input.parseState === "parsed" ? "literal" : "byte-scan-candidate";
  const inComment =
    input.parseState === "parsed" && input.commentRanges !== undefined
      ? commentLookup(input.file, input.commentRanges, source.length)
      : (): boolean => false;
  const endpoints = detectEndpoints(
    input.file,
    source,
    lineStarts,
    confidence,
    inComment,
  );
  const obfuscationPatterns = detectObfuscationPatterns(
    input.file,
    source,
    lineStarts,
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

/** Combines per-file observations into a stable, deduplicated signal set. */
export function buildSignalSet(
  observations: readonly ReturnType<typeof observeSignalSource>[],
): SignalSet {
  const sourceFiles = observations.map(({ file }) => file);
  sourceFiles.sort((left, right) => compareText(left.file, right.file));

  const endpoints = deduplicateEndpoints(
    observations.flatMap(({ endpoints: found }) => found),
  );
  const obfuscationPatterns = deduplicateObfuscationPatterns(
    observations.flatMap(({ obfuscationPatterns: found }) => found),
  );
  return { sourceFiles, endpoints, obfuscationPatterns };
}

function detectEndpoints(
  file: string,
  source: string,
  lineStarts: readonly number[],
  confidence: SignalEndpointObservation["confidence"],
  inComment: (start: number, end: number) => boolean,
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
      // A bounded lexical candidate is not evidence of a valid endpoint.
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
      endpoint(file, host, endpointType, source, lineStarts, index, confidence),
    );
  }

  for (const match of source.matchAll(IPV4_LITERAL_RE)) {
    const value = match[0];
    const index = match.index;
    if (inComment(index, index + match[0].length)) continue;
    if (isIP(value) !== 4 || !isExternalHost(value, "ipv4")) continue;
    found.push(
      endpoint(file, value, "ipv4", source, lineStarts, index, confidence),
    );
  }

  for (const match of source.matchAll(IPV6_LITERAL_RE)) {
    const value = match[0];
    const index = match.index;
    if (inComment(index, index + match[0].length)) continue;
    if (isIP(value) !== 6 || !isExternalHost(value, "ipv6")) continue;
    found.push(
      endpoint(
        file,
        value.toLowerCase(),
        "ipv6",
        source,
        lineStarts,
        index,
        confidence,
      ),
    );
  }
  return found;
}

function endpoint(
  file: string,
  value: string,
  endpointType: SignalEndpointObservation["endpointType"],
  source: string,
  lineStarts: readonly number[],
  index: number,
  confidence: SignalEndpointObservation["confidence"],
): SignalEndpointObservation {
  return {
    kind: "EXTERNAL_ENDPOINT",
    endpointType,
    normalizedValue: value,
    confidence,
    evidence: [{ ...evidenceAt(source, lineStarts, index), file }],
  };
}

function detectObfuscationPatterns(
  file: string,
  source: string,
  lineStarts: readonly number[],
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
      evidence: [{ ...evidenceAt(source, lineStarts, index), file }],
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

function deduplicateEndpoints(
  observations: readonly SignalEndpointObservation[],
): SignalEndpointObservation[] {
  const grouped = new Map<string, SignalEndpointObservation>();
  for (const observation of observations) {
    const key = JSON.stringify([
      observation.endpointType,
      observation.normalizedValue,
    ]);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, observation);
      continue;
    }
    const evidence = mergeEvidence(current.evidence, observation.evidence);
    grouped.set(key, {
      ...current,
      confidence:
        current.confidence === "literal" || observation.confidence === "literal"
          ? "literal"
          : "byte-scan-candidate",
      evidence,
    });
  }
  return [...grouped.values()].sort((left, right) =>
    compareText(
      JSON.stringify([left.endpointType, left.normalizedValue]),
      JSON.stringify([right.endpointType, right.normalizedValue]),
    ),
  );
}

function deduplicateObfuscationPatterns(
  observations: readonly SignalObfuscationObservation[],
): SignalObfuscationObservation[] {
  const grouped = new Map<string, SignalObfuscationObservation>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.file, observation.pattern]);
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, observation);
      continue;
    }
    grouped.set(key, {
      ...current,
      elementCount: Math.max(current.elementCount, observation.elementCount),
      evidence: mergeEvidence(current.evidence, observation.evidence),
    });
  }
  return [...grouped.values()].sort((left, right) =>
    compareText(
      JSON.stringify([left.file, left.pattern]),
      JSON.stringify([right.file, right.pattern]),
    ),
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
  lineStarts: readonly number[],
  index: number,
): Evidence {
  const lineIndex = lineForIndex(lineStarts, index);
  const lineStart = lineStarts[lineIndex] ?? 0;
  const nextLineStart = lineStarts[lineIndex + 1] ?? source.length;
  const snippet = source
    .slice(lineStart, nextLineStart)
    .replace(/[\r\n]+$/gu, "")
    .trim()
    .slice(0, MAX_EVIDENCE_SNIPPET);
  return { file: "", line: lineIndex + 1, snippet };
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineForIndex(lineStarts: readonly number[], index: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle] ?? 0;
    if (start <= index) low = middle;
    else high = middle;
  }
  return low;
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

function compareEvidence(left: Evidence, right: Evidence): number {
  return compareText(
    JSON.stringify([left.file, left.line, left.snippet]),
    JSON.stringify([right.file, right.line, right.snippet]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
