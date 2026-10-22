// JavaScript's \s matches U+FEFF, but the WHATWG URL parser drops it from a
// host (UTS-46), so it does not separate words in a URL.
const WORD_SEPARATOR_RE = /[^\S\uFEFF]/u;

/**
 * Reports whether a string's runtime value holds whitespace after the WHATWG
 * URL parser's input normalization. Every step only removes characters, so it
 * can only make a URL more literal, never demote it.
 */
export function valueHasWords(value: string): boolean {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  const stripped = value
    .slice(start, end)
    .replaceAll("\t", "")
    .replaceAll("\n", "")
    .replaceAll("\r", "")
    .trim();
  return WORD_SEPARATOR_RE.test(stripped);
}
