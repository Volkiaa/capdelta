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

/** Half-open [start, end) UTF-16 offsets into the parsed source string. */
export type CommentRange = readonly [start: number, end: number];

export interface ParserSuccess {
  ok: true;
  detections: readonly ParserDetection[];
  /** Comments of the successful parse only, in source order; may be empty. */
  comments: readonly CommentRange[];
}

export interface ParserFailure {
  ok: false;
  detail: string;
  line: number;
  snippet: string;
}

export type ParserResponse = ParserSuccess | ParserFailure;
