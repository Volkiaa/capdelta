import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { lineIndexAt, lineStarts } from "./line-index.js";

/**
 * Reference result computed by a linear scan, independent of the binary search
 * under test: the last line whose start is at or before the offset.
 */
function scanLineIndex(starts: readonly number[], offset: number): number {
  let line = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= offset) line = index;
  }
  return line;
}

function checkEveryOffset(text: string): void {
  const starts = lineStarts(text);
  for (let offset = 0; offset <= text.length; offset += 1) {
    expect(lineIndexAt(starts, offset)).toBe(scanLineIndex(starts, offset));
  }
}

describe("lineStarts", () => {
  it("starts at 0 and one past every newline", () => {
    expect(lineStarts("a\nb\r\nc")).toEqual([0, 2, 5]);
  });
});

describe("lineIndexAt", () => {
  it("matches a linear scan for every offset on LF text", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 12 }), (lines) => {
        checkEveryOffset(lines.join("\n"));
      }),
    );
  });

  it("matches a linear scan for every offset on CRLF text", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 12 }), (lines) => {
        checkEveryOffset(lines.join("\r\n"));
      }),
    );
  });

  it("matches a linear scan for every offset on text without a newline", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        checkEveryOffset(text.replace(/[\r\n]/gu, ""));
      }),
    );
  });
});
