import type { CodeCapabilityKind } from "../contract/capability-set.js";

export interface ParserRequest {
  source: string;
  file: string;
  sourceType: "module" | "script" | "either";
}

export interface ParserDetection {
  kind: CodeCapabilityKind;
  line: number;
  snippet: string;
}

export type CommentRange = readonly [start: number, end: number];

export interface ParserSuccess {
  ok: true;
  detections: readonly ParserDetection[];
  comments: readonly CommentRange[];
  /** String content offsets, excluding quotes and backticks. */
  stringRanges: readonly CommentRange[];
}

export interface ParserFailure {
  ok: false;
  detail: string;
  line: number;
  snippet: string;
}

export type ParserResponse = ParserSuccess | ParserFailure;
