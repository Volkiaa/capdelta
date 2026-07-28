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

export interface ParserSuccess {
  ok: true;
  detections: readonly ParserDetection[];
}

export interface ParserFailure {
  ok: false;
  detail: string;
  line: number;
  snippet: string;
}

export type ParserResponse = ParserSuccess | ParserFailure;
