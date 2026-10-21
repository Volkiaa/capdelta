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
}

export interface ParserFailure {
  ok: false;
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
