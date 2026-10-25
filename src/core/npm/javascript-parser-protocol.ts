import type { CodeCapabilityKind } from "../contract/capability-set.js";

export interface ParserRequest {
  source: string;
  file: string;
  language: "javascript" | "typescript";
  sourceType: "module" | "script" | "either";
}

export interface ParserDetection {
  kind: CodeCapabilityKind;
  line: number;
  snippet: string;
}

export type CommentRange = readonly [start: number, end: number];

/** String content offsets plus whether the runtime value holds whitespace. */
export type StringRange = readonly [
  start: number,
  end: number,
  valueHasWords: boolean,
];

export interface ParserSuccess {
  ok: true;
  detections: readonly ParserDetection[];
  comments: readonly CommentRange[];
  /** String content offsets, excluding quotes and backticks. */
  stringRanges: readonly StringRange[];
  /** Cooked value of each string whose raw content holds a backslash. */
  cookedStrings: readonly (readonly [start: number, value: string])[];
  /** Line of a module-scope loop that has no exit condition, if any. */
  topLevelLoop?: { line: number };
}

export interface ParserFailure {
  ok: false;
  reason: "syntax" | "unsupported-typescript";
  detail: string;
  line: number;
  snippet: string;
}

export type ParserResponse = ParserSuccess | ParserFailure;

/** Posted once, after the worker registers its message listener. */
export interface ParserReadyMessage {
  type: "ready";
}

export type ParserWorkerMessage = ParserReadyMessage | ParserResponse;
