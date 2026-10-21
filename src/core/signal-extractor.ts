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
import type { StringRange } from "./npm/javascript-parser-protocol.js";

/** Provisional thresholds; PLAN §4.4 leaves corpus tuning to validation. */
export const MIN_ENTROPY_BYTES = 256 as const;
export const ENTROPY_JUMP_MILLIBITS = 1_000 as const;
export const HIGH_ENTROPY_MILLIBITS = 6_500 as const;
export const MIN_OBFUSCATION_ARRAY_ELEMENTS = 8 as const;

const MAX_EVIDENCE_SNIPPET = 240;
// Only the scheme and authority decide the host, so a match stops at the first
// "/", "?" or "#" after it. That keeps every match short, so rescanning after
// a template element boundary costs one authority, never the rest of the file.
// Extra leading slashes are kept: "https:///evil.test" still reaches evil.test.
const URL_STOP_RE = /[\s"'`<>\\]/u;
const URL_LITERAL_RE = /\b(?:https?|wss?):\/\/\/*[^\s"'`<>\\/?#]*/gu;
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
   * half-open UTF-16 offsets excluding quotes and backticks, plus whether the
   * string's runtime value holds whitespace. Only applied when parseState is
   * "parsed"; absent means every URL is "unknown".
   */
  stringRanges?: readonly StringRange[];
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
  const stringRanges =
    input.parseState === "parsed" && input.stringRanges !== undefined
      ? stringRangeLookup(input.file, input.stringRanges, source)
      : undefined;
  const contextAt =
    stringRanges?.contextAt ?? ((): SignalEndpointContext => "unknown");
  const rangeEndAt = stringRanges?.rangeEndAt ?? ((): number | null => null);
  const ipv6ContextAt =
    stringRanges?.ipv6ContextAt ?? ((): SignalEndpointContext => "unknown");
  const endpoints = detectEndpoints(
    input.file,
    source,
    starts,
    confidence,
    inComment,
    contextAt,
    rangeEndAt,
    ipv6ContextAt,
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
    (group): SignalEndpointObservation => ({
      ...group[0],
      confidence: group.some(({ confidence }) => confidence === "literal")
        ? "literal"
        : "byte-scan-candidate",
      context: group.reduce(
        (context, next) => strongestContext(context, next.context),
        group[0].context,
      ),
      evidence: mergeEvidence(group.map(({ evidence }) => evidence)),
    }),
  );
  const obfuscationPatterns = mergeByKey(
    observations.flatMap(({ obfuscationPatterns: found }) => found),
    (observation) => JSON.stringify([observation.file, observation.pattern]),
    (group) => ({
      ...group[0],
      elementCount: group.reduce(
        (count, next) => Math.max(count, next.elementCount),
        group[0].elementCount,
      ),
      evidence: mergeEvidence(group.map(({ evidence }) => evidence)),
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
  rangeEndAt: (start: number) => number | null,
  ipv6ContextAt: (start: number, end: number) => SignalEndpointContext,
): SignalEndpointObservation[] {
  const found: SignalEndpointObservation[] = [];
  // The regex is global, so it carries lastIndex between calls. Reset it and
  // move it explicitly when a match stops short of the regex's own end.
  URL_LITERAL_RE.lastIndex = 0;
  let stopCursor = 0;
  for (
    let match = URL_LITERAL_RE.exec(source);
    match !== null;
    match = URL_LITERAL_RE.exec(source)
  ) {
    const index = match.index;
    const authority = match[0];
    // The URL's lexical span is what #150's boundary rule and the comment check
    // judge; only its authority is parsed. The stop cursor moves forward only,
    // so finding every span's end stays linear in the source size.
    if (stopCursor < index) stopCursor = index;
    while (
      stopCursor < source.length &&
      !URL_STOP_RE.test(source.charAt(stopCursor))
    )
      stopCursor += 1;
    const lexicalEnd = stopCursor;
    const rangeEnd = rangeEndAt(index);
    // A template element ends at `${`, which a URL span does not stop at. An
    // uncut span would take the next element's text into this element's
    // context and could swallow the next element's URL, so the cut part keeps
    // this element's context and scanning resumes at the element's end. The
    // whole span is kept as "unknown" too, because the runtime string can
    // still join across the expression (`https://a.test${x}@evil.test/`).
    const crosses = rangeEnd !== null && lexicalEnd > rangeEnd;
    // The parser sees the delimiter after the authority too, so a trailing
    // control character is rejected as on a full URL, never stripped.
    const authorityEnd = index + authority.length;
    const delimited =
      authorityEnd < lexicalEnd
        ? source.slice(index, authorityEnd + 1)
        : authority;
    const candidates: [string, number, SignalEndpointContext][] = crosses
      ? [
          [
            source.slice(index, Math.min(rangeEnd, index + delimited.length)),
            rangeEnd,
            contextAt(index),
          ],
          [delimited, lexicalEnd, "unknown"],
        ]
      : [[delimited, lexicalEnd, contextAt(index)]];
    URL_LITERAL_RE.lastIndex = crosses ? rangeEnd : lexicalEnd;
    for (const [value, spanEnd, context] of candidates) {
      // Documentation links in comments are not runtime endpoints; a match
      // that runs into a comment ("https://x\n" after a label) is not one
      // either.
      if (inComment(index, spanEnd)) continue;
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
      if (endpointType === null || !isExternalHost(host, endpointType))
        continue;
      found.push(
        endpoint(
          file,
          host,
          endpointType,
          source,
          starts,
          index,
          confidence,
          context,
        ),
      );
    }
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
          // ADR-027 classifies bare IPv6 by its string; IPv4 keeps "unknown".
          row.family === 6
            ? ipv6ContextAt(index, index + value.length)
            : "unknown",
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
 * Groups items by a JSON key, merges each group once, and sorts the result by
 * the same key with the shared text comparator.
 */
function mergeByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  merge: (items: readonly [T, ...T[]]) => T,
): T[] {
  const grouped = new Map<string, [T, ...T[]]>();
  for (const item of items) {
    const key = keyOf(item);
    const current = grouped.get(key);
    if (current === undefined) grouped.set(key, [item]);
    else current.push(item);
  }
  return [...grouped.values()]
    .map((group) => (group.length === 1 ? group[0] : merge(group)))
    .sort((left, right) => compareText(keyOf(left), keyOf(right)));
}

/**
 * Merges every observation's evidence in one pass, so a file with thousands of
 * matches for one host does not re-sort a growing list on each merge. An exact
 * duplicate (same file, line and snippet) is kept once.
 */
function mergeEvidence(lists: readonly EvidenceList[]): EvidenceList {
  const unique = new Map<string, Evidence>();
  for (const list of lists) {
    for (const item of list) {
      unique.set(JSON.stringify([item.file, item.line, item.snippet]), item);
    }
  }
  const sorted = [...unique.values()].sort(compareEvidence);
  const [first, ...rest] = sorted;
  if (first === undefined) {
    throw new Error("signal evidence merge produced no evidence");
  }
  return [first, ...rest];
}

// One snippet per line per source. Building it trims the whole line, so
// building it per match made many matches on one long line quadratic.
const snippetsBySource = new WeakMap<readonly number[], Map<number, string>>();

function evidenceAt(
  source: string,
  starts: readonly number[],
  index: number,
): Evidence {
  const lineIndex = lineIndexAt(starts, index);
  let snippets = snippetsBySource.get(starts);
  if (snippets === undefined) {
    snippets = new Map();
    snippetsBySource.set(starts, snippets);
  }
  let snippet = snippets.get(lineIndex);
  if (snippet === undefined) {
    const lineStart = starts[lineIndex] ?? 0;
    const nextLineStart = starts[lineIndex + 1] ?? source.length;
    snippet = source
      .slice(lineStart, nextLineStart)
      .trim()
      .slice(0, MAX_EVIDENCE_SNIPPET);
    snippets.set(lineIndex, snippet);
  }
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
const TRAILING_PUNCTUATION = new Set(")]}>,.;:!?'\"");

function publicStyleDomain(host: string): string | null {
  if (isPublicStyleDomain(host)) return host;
  // A backward scan, not a `+$` regex, which retries every suffix.
  let end = host.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(host.charAt(end - 1))) end -= 1;
  const trimmed = host.slice(0, end);
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
 * A match that starts inside a range is "embedded-text" only when the raw
 * content between the quotes and the string's runtime value both hold
 * whitespace; neither check alone may demote a URL. A backslash before a line
 * terminator is a JavaScript line continuation, and the URL parser drops ASCII
 * tab and newline anywhere in its input, so neither separates words. Deleting
 * them can only keep a URL literal, never demote it.
 */
function wordsOf(raw: string): string {
  return raw.replace(/\\(?:\r\n|[\n\r\u2028\u2029])|[\t\n\r]/gu, "").trim();
}

function stringRangeLookup(
  file: string,
  ranges: readonly StringRange[],
  source: string,
): {
  contextAt: (start: number) => SignalEndpointContext;
  rangeEndAt: (start: number) => number | null;
  ipv6ContextAt: (start: number, end: number) => SignalEndpointContext;
} {
  let previousEnd = 0;
  for (const [start, end, valueWords] of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      typeof valueWords !== "boolean" ||
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
  const contexts = new Map<number, SignalEndpointContext>();
  const escapeByRange = new Map<number, boolean>();
  return {
    contextAt: (start) => {
      const range = containingStringRange(ranges, start);
      if (range === undefined) return "unknown";
      // One classification per string: it reads the whole string, so doing it
      // per URL made many URLs in one string quadratic.
      let context = contexts.get(range[0]);
      if (context === undefined) {
        // Neither the raw form nor the value alone may demote a URL.
        context =
          /\s/u.test(wordsOf(source.slice(range[0], range[1]))) && range[2]
            ? "embedded-text"
            : "literal";
        contexts.set(range[0], context);
      }
      return context;
    },
    rangeEndAt: (start) => containingStringRange(ranges, start)?.[1] ?? null,
    ipv6ContextAt: (start, end) => {
      const range = containingStringRange(ranges, start);
      if (range === undefined || end > range[1]) return "unknown";
      // A backslash anywhere in the raw string keeps the match "unknown", so
      // an escape cannot lower it. One scan per string: reading the whole
      // string per match, as the URL context above also avoids, is quadratic.
      let hasEscape = escapeByRange.get(range[0]);
      if (hasEscape === undefined) {
        hasEscape = source.slice(range[0], range[1]).includes("\\");
        escapeByRange.set(range[0], hasEscape);
      }
      if (hasEscape) return "unknown";
      return ipv6GluedContext(range, start, end, source)
        ? "embedded-text"
        : "unknown";
    },
  };
}

/** Last range that starts at or before `start`, if that range still covers it. */
function containingStringRange(
  ranges: readonly StringRange[],
  start: number,
): StringRange | undefined {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (range !== undefined && range[0] <= start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low - 1];
  return range !== undefined && range[1] > start ? range : undefined;
}

// `=`, `&`, `?`, `#` and `|` bound a value in key-value and query strings.
const IPV6_SEPARATOR_RE = /[\s,;[\]()/@"'=&?#|<>]/u;
const IPV6_TOKEN_CHAR_RE = /[0-9a-f:.]/iu;

function isIpv6Separator(char: string): boolean {
  return char === "" || IPV6_SEPARATOR_RE.test(char);
}

// Node accepts at most 45 characters for an address written out, an IPv6
// address with a dotted IPv4 tail. A longer token cannot be one, so the token
// scan stops just past that limit: a match in a string that is one long run of
// hex digits and colons then costs a constant, not the string's length.
const MAX_IPV6_ADDRESS_LENGTH = 45;

/**
 * ADR-027: a bare IPv6 match is glued when a character other than a separator
 * touches its whole address token within the string.
 */
function ipv6GluedContext(
  range: StringRange,
  start: number,
  end: number,
  source: string,
): boolean {
  // The pattern can stop inside an address Node accepts, before a dotted IPv4
  // tail or a zone ID, so judge the whole token, never the match alone.
  let tokenStart = start;
  let tokenEnd = end;
  while (
    tokenStart > range[0] &&
    tokenEnd - tokenStart <= MAX_IPV6_ADDRESS_LENGTH &&
    IPV6_TOKEN_CHAR_RE.test(source.charAt(tokenStart - 1))
  )
    tokenStart -= 1;
  while (
    tokenEnd < range[1] &&
    tokenEnd - tokenStart <= MAX_IPV6_ADDRESS_LENGTH &&
    IPV6_TOKEN_CHAR_RE.test(source.charAt(tokenEnd))
  )
    tokenEnd += 1;
  if (tokenEnd - tokenStart > MAX_IPV6_ADDRESS_LENGTH) return false;
  if (isIP(source.slice(tokenStart, tokenEnd)) !== 6) return false;
  const before = tokenStart > range[0] ? source.charAt(tokenStart - 1) : "";
  const after = tokenEnd < range[1] ? source.charAt(tokenEnd) : "";
  if (after === "%") return false;
  return !isIpv6Separator(before) || !isIpv6Separator(after);
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
