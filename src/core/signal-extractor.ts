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
interface IpLiteralRow {
  pattern: RegExp;
  family: 4 | 6;
  endpointType: SignalEndpointObservation["endpointType"];
  lowercase: boolean;
  /** Canonical dotted decimal for a non-canonical IPv4 form, or null. */
  normalize?: (value: string) => string | null;
}

// inet_aton accepts a four-part host where a part is hex ("0x" plus hex
// digits) or octal (a leading "0" plus digits), and leading zeros do not
// change the value. One byte holds at most two significant hex digits or three
// significant octal digits, so each form consumes any run of leading zeros
// and at most that many significant digits. The significant group is optional
// and starts non-zero, so every alternative consumes a different first
// character and a long zero run cannot backtrack.
const IPV4_HEX_PART = "0[xX]0*(?:[1-9a-fA-F][0-9a-fA-F]{0,1})?";
const IPV4_OCTAL_PART = "0+(?:[1-7][0-7]{0,2})?";
const IPV4_DECIMAL_PART = "[1-9][0-9]{0,2}";
const IPV4_PART_SOURCE = `(?:${IPV4_HEX_PART}|${IPV4_OCTAL_PART}|${IPV4_DECIMAL_PART})`;
const IPV4_ATON_RE = new RegExp(
  `\\b${IPV4_PART_SOURCE}(?:\\.${IPV4_PART_SOURCE}){3}\\b`,
  "gu",
);

const IP_LITERAL_ROWS: readonly IpLiteralRow[] = [
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
  {
    pattern: IPV4_ATON_RE,
    family: 4,
    endpointType: "ipv4",
    lowercase: false,
    normalize: normalizeMixedIpv4,
  },
];
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
  /**
   * Cooked value of each string whose raw content holds a backslash, keyed by
   * the start of its string range. Only applied when parseState is "parsed".
   */
  cookedStrings?: readonly (readonly [start: number, value: string])[];
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
  const cookedStrings =
    input.parseState === "parsed" && input.cookedStrings !== undefined
      ? cookedLookup(input.file, input.stringRanges ?? [], input.cookedStrings)
      : [];
  const endpoints = detectEndpoints(
    input.file,
    source,
    starts,
    confidence,
    inComment,
    contextAt,
    rangeEndAt,
    ipv6ContextAt,
    cookedStrings,
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
      provenance: group.some(({ provenance }) => provenance === "established")
        ? "established"
        : "additive",
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
  cookedStrings: readonly (readonly [number, string])[],
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
      const observation = urlEndpoint(
        file,
        value,
        source,
        starts,
        index,
        confidence,
        context,
      );
      if (observation !== null) found.push(observation);
    }
  }

  ipLiteralEndpoints(
    file,
    source,
    starts,
    confidence,
    {
      text: source,
      evidenceIndex: (index) => index,
      excluded: inComment,
      ipv6Context: (start, end) => ipv6ContextAt(start, end),
      // ADR-037: main already scans the raw source with these rows.
      provenance: "established",
    },
    found,
  );

  // ADR-026: cooked matches join the raw matches here, so the per-host
  // aggregation below decides severity (ADR-024 strongest-context-wins)
  // instead of a separate dedupe that could drop the stronger one.
  for (const [start, value] of cookedStrings) {
    const context = contextAt(start);
    // The WHATWG URL parser removes ASCII tab, LF and CR from its input, so
    // the runtime fetches the URL that remains. URL_LITERAL_RE would stop at
    // them, so remove them before matching and keep the URL visible.
    const cooked = value.replace(/[\t\n\r]/gu, "");
    URL_LITERAL_RE.lastIndex = 0;
    let stopCursor = 0;
    for (
      let match = URL_LITERAL_RE.exec(cooked);
      match !== null;
      match = URL_LITERAL_RE.exec(cooked)
    ) {
      const index = match.index;
      const authority = match[0];
      // The span rule and the delimiter are the raw scan's: a URL's path or
      // query is not a second URL, and a control character after the
      // authority is rejected instead of stripped.
      if (stopCursor < index) stopCursor = index;
      while (
        stopCursor < cooked.length &&
        !URL_STOP_RE.test(cooked.charAt(stopCursor))
      )
        stopCursor += 1;
      const authorityEnd = index + authority.length;
      const delimited =
        authorityEnd < stopCursor
          ? cooked.slice(index, authorityEnd + 1)
          : authority;
      URL_LITERAL_RE.lastIndex = stopCursor;
      const observation = urlEndpoint(
        file,
        delimited,
        source,
        starts,
        start,
        confidence,
        context,
      );
      if (observation !== null) found.push(observation);
    }
    // The IP rows scan the same cooked value, so an escape cannot hide a bare
    // address either. A cooked value never comes from a comment, so no match
    // is excluded here.
    ipLiteralEndpoints(
      file,
      source,
      starts,
      confidence,
      {
        text: value,
        evidenceIndex: () => start,
        excluded: () => false,
        // ADR-027 judges glue against the text that runs, which is the cooked
        // value, not the raw source with its escapes.
        ipv6Context: (index, end) =>
          ipv6GluedIn(value, 0, value.length, index, end)
            ? "embedded-text"
            : "unknown",
        // ADR-037: main does not scan cooked values with the IP rows, so every
        // address this scan finds may be invisible to main.
        provenance: "additive",
      },
      found,
    );
  }
  return found;
}

interface IpLiteralScan {
  /** The raw source, or one string's cooked value. */
  text: string;
  /** Offset in the source used for the observation's evidence. */
  evidenceIndex: (matchIndex: number) => number;
  /** True when the match must be skipped; only the raw scan skips comments. */
  excluded: (start: number, end: number) => boolean;
  /** ADR-027 context for an IPv6 match. */
  ipv6Context: (start: number, end: number) => SignalEndpointContext;
  /** ADR-037: main's raw scan is established; the cooked scan is additive. */
  provenance: SignalEndpointObservation["provenance"];
}

/**
 * Runs the shared IP literal rows over one text. The raw scan and each cooked
 * string's scan differ only in where a match is reported and how an IPv6
 * context is decided.
 *
 * Appends to the caller's accumulator one match at a time. A spread argument
 * (`found.push(...matches)`) fails with "Maximum call stack size exceeded"
 * when a valid source holds enough matches, which would suppress every
 * observation from the file.
 */
function ipLiteralEndpoints(
  file: string,
  source: string,
  starts: readonly number[],
  confidence: SignalEndpointObservation["confidence"],
  scan: IpLiteralScan,
  found: SignalEndpointObservation[],
): void {
  for (const row of IP_LITERAL_ROWS) {
    for (const match of scan.text.matchAll(row.pattern)) {
      const value = match[0];
      const index = match.index;
      if (scan.excluded(index, index + value.length)) continue;
      const normalized =
        row.normalize === undefined ? value : row.normalize(value);
      if (normalized === null || isIP(normalized) !== row.family) continue;
      if (!isExternalHost(normalized, row.endpointType)) continue;
      found.push(
        endpoint(
          file,
          row.lowercase ? normalized.toLowerCase() : normalized,
          row.endpointType,
          source,
          starts,
          scan.evidenceIndex(index),
          confidence,
          // ADR-027 classifies bare IPv6 by its string; IPv4 keeps "unknown".
          row.family === 6
            ? scan.ipv6Context(index, index + value.length)
            : "unknown",
          scan.provenance,
        ),
      );
    }
  }
}

function urlEndpoint(
  file: string,
  value: string,
  source: string,
  starts: readonly number[],
  index: number,
  confidence: SignalEndpointObservation["confidence"],
  context: SignalEndpointContext,
): SignalEndpointObservation | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const rawHost = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  const endpointType = endpointTypeFor(rawHost);
  const host = endpointType === "domain" ? publicStyleDomain(rawHost) : rawHost;
  if (host === null) return null;
  if (endpointType === null || !isExternalHost(host, endpointType)) return null;
  return endpoint(
    file,
    host,
    endpointType,
    source,
    starts,
    index,
    confidence,
    context,
    "established",
  );
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
  provenance: SignalEndpointObservation["provenance"],
): SignalEndpointObservation {
  return {
    kind: "EXTERNAL_ENDPOINT",
    endpointType,
    normalizedValue: value,
    confidence,
    context,
    provenance,
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
// DNS allows any octet in a label, so getaddrinfo resolves `a_b.example.test`.
// An attacker controls their own zone's records, so dropping the host would
// hide a reachable endpoint. The TLD keeps the stricter rule above.
const NON_TLD_DOMAIN_LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u;
const MAX_DOMAIN_LENGTH = 253;

/**
 * Public-style hostname heuristic (not a DNS definition): at least two
 * labels, letter-digit-hyphen or underscore non-TLD labels, and an
 * alphabetic or punycode TLD. It drops lexical
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
  if (
    !labels.every((label, index) =>
      index === labels.length - 1
        ? DOMAIN_LABEL_RE.test(label)
        : NON_TLD_DOMAIN_LABEL_RE.test(label),
    )
  ) {
    return false;
  }
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
  return ipv6GluedIn(source, range[0], range[1], start, end);
}

/**
 * ADR-027's glue rule over `text`, bounded by the container that holds the
 * match. The raw scan bounds it to the string's range; the cooked scan passes
 * the cooked value with the whole value as the container.
 */
function ipv6GluedIn(
  text: string,
  containerStart: number,
  containerEnd: number,
  start: number,
  end: number,
): boolean {
  // The pattern can stop inside an address Node accepts, before a dotted IPv4
  // tail or a zone ID, so judge the whole token, never the match alone.
  let tokenStart = start;
  let tokenEnd = end;
  while (
    tokenStart > containerStart &&
    tokenEnd - tokenStart <= MAX_IPV6_ADDRESS_LENGTH &&
    IPV6_TOKEN_CHAR_RE.test(text.charAt(tokenStart - 1))
  )
    tokenStart -= 1;
  while (
    tokenEnd < containerEnd &&
    tokenEnd - tokenStart <= MAX_IPV6_ADDRESS_LENGTH &&
    IPV6_TOKEN_CHAR_RE.test(text.charAt(tokenEnd))
  )
    tokenEnd += 1;
  if (tokenEnd - tokenStart > MAX_IPV6_ADDRESS_LENGTH) return false;
  if (isIP(text.slice(tokenStart, tokenEnd)) !== 6) return false;
  const before = tokenStart > containerStart ? text.charAt(tokenStart - 1) : "";
  const after = tokenEnd < containerEnd ? text.charAt(tokenEnd) : "";
  if (after === "%") return false;
  return !isIpv6Separator(before) || !isIpv6Separator(after);
}

/**
 * Validates the parser's cooked values against its string ranges, so a broken
 * parser response fails loudly instead of hiding or moving an endpoint.
 */
function cookedLookup(
  file: string,
  ranges: readonly StringRange[],
  cookedStrings: readonly (readonly [number, string])[],
): readonly (readonly [number, string])[] {
  const rangeByStart = new Map<number, StringRange>();
  for (const range of ranges) rangeByStart.set(range[0], range);
  const validated: (readonly [number, string])[] = [];
  let previousStart = -1;
  for (const [start, value] of cookedStrings) {
    const range = rangeByStart.get(start);
    if (
      !Number.isSafeInteger(start) ||
      typeof value !== "string" ||
      range === undefined ||
      start <= previousStart ||
      value.length > range[1] - start
    ) {
      throw new RangeError(
        `invalid parser cooked strings for ${JSON.stringify(file)}`,
      );
    }
    validated.push([start, value]);
    previousStart = start;
  }
  return validated;
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

/**
 * Converts a four-part dotted host that uses at least one inet_aton hex or
 * octal part into dotted decimal. A canonical dotted decimal returns null, so
 * the canonical row keeps reporting it unchanged.
 */
function normalizeMixedIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  let nonCanonical = false;
  for (const part of parts) {
    const octet = ipv4PartOctet(part);
    if (octet === null) return null;
    octets.push(octet);
    if (isNonCanonicalIpv4Part(part)) nonCanonical = true;
  }
  return nonCanonical ? octets.join(".") : null;
}

function isNonCanonicalIpv4Part(part: string): boolean {
  return (
    part.startsWith("0x") ||
    part.startsWith("0X") ||
    (part.length > 1 && part.startsWith("0"))
  );
}

function ipv4PartOctet(part: string): number | null {
  let value: number;
  if (part.startsWith("0x") || part.startsWith("0X")) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (part.length > 1 && part.startsWith("0")) {
    // A leading zero means octal in inet_aton; "0" alone is decimal zero.
    if (!/^[0-7]+$/u.test(part.slice(1))) return null;
    value = Number.parseInt(part.slice(1), 8);
  } else {
    value = Number.parseInt(part, 10);
  }
  return Number.isSafeInteger(value) && value >= 0 && value <= 255
    ? value
    : null;
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
