import { parse, type Node } from "acorn";
import { fullAncestor } from "acorn-walk";
import type {
  CommentRange,
  ParserRequest,
  StringRange,
} from "./javascript-parser-protocol.js";
import { valueHasWords } from "./url-value-words.js";

export interface ParsedSource {
  ast: Node;
  comments: CommentRange[];
}

export function parseSource(
  source: string,
  sourceType: ParserRequest["sourceType"],
): ParsedSource {
  const attempt = (next: "module" | "script") => {
    const comments: CommentRange[] = [];
    const ast = parse(source, {
      ecmaVersion: "latest",
      allowHashBang: true,
      locations: true,
      sourceType: next,
      onComment: (_block, _text, start, end) => {
        comments.push([start, end]);
      },
    });
    return { ast, comments };
  };
  if (sourceType !== "either") return attempt(sourceType);
  try {
    return attempt("module");
  } catch {
    return attempt("script");
  }
}

export interface CollectedStringContent {
  stringRanges: StringRange[];
  cookedStrings: (readonly [start: number, value: string])[];
}

/**
 * Collects the same string content the parser worker reports: both the ranges
 * that decide a URL's context and the cooked values of escaped strings.
 */
export function collectStringContent(
  ast: Node,
  source: string,
): CollectedStringContent {
  const stringRanges: StringRange[] = [];
  const cookedStrings: (readonly [start: number, value: string])[] = [];
  fullAncestor(ast, (node) => {
    const content = stringContent(node, source);
    if (content === null) return;
    stringRanges.push(content.range);
    if (content.cooked !== null) cookedStrings.push(content.cooked);
  });
  stringRanges.sort((left, right) => left[0] - right[0]);
  cookedStrings.sort((left, right) => left[0] - right[0]);
  return { stringRanges, cookedStrings };
}

export interface StringContent {
  range: StringRange;
  /** Present only when the raw content holds a backslash (ADR-026). */
  cooked: readonly [start: number, value: string] | null;
}

/**
 * A string Literal's start/end include its quotes, while acorn's
 * TemplateElement start/end already bound the raw content between the backtick
 * and the next `${` or backtick. A tagged template with an invalid escape has
 * no cooked value, so it cannot demote a URL.
 *
 * The parser worker calls this inside its own walk, so both callers push one
 * item at a time instead of spreading an array sized by the input.
 */
export function stringContent(
  node: Node,
  source: string,
): StringContent | null {
  const record = node as unknown as Record<string, unknown>;
  const isTemplate = node.type === "TemplateElement";
  const cooked = isTemplate ? asRecord(record.value)?.cooked : record.value;
  if (isTemplate) {
    return {
      range: [
        node.start,
        node.end,
        typeof cooked === "string" && valueHasWords(cooked),
      ],
      cooked:
        typeof cooked === "string" &&
        needsCookedValue(source, node.start, node.end)
          ? [node.start, cooked]
          : null,
    };
  }
  if (node.type !== "Literal" || typeof cooked !== "string") return null;
  const start = node.start + 1;
  const end = node.end - 1;
  return {
    range: [start, end, valueHasWords(cooked)],
    cooked: needsCookedValue(source, start, end) ? [start, cooked] : null,
  };
}

/**
 * A backslash can encode a URL character, and a raw tab, LF or CR hides a URL
 * from the literal scan even though the WHATWG URL parser removes it. A
 * template literal can hold a real newline, so report these strings too.
 */
function needsCookedValue(source: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    if (
      character === "\\" ||
      character === "\t" ||
      character === "\n" ||
      character === "\r"
    ) {
      return true;
    }
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
