import type { EventInfo, ParamInfo, Language } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * Extract component events from Vue defineEmits declarations and emit() calls.
 * Returns an empty array for non-JS/TS languages.
 */
export function extractEvents(
  sourceText: string,
  language: Language,
): EventInfo[] {
  if (language !== "typescript" && language !== "javascript") return [];

  const events: EventInfo[] = [];
  const seen = new Set<string>();

  // Strategy A: defineEmits<{ (e: 'name', ...): void }>() — call-signature form
  extractDefineEmitsCallSignatures(sourceText, events, seen);

  // Strategy B: defineEmits(['name1', 'name2']) — array form
  extractDefineEmitsArray(sourceText, events, seen);

  // Strategy C: emit('name', ...) calls as fallback
  extractEmitCalls(sourceText, events, seen);

  // Strategy D: an Angular component's outputs.
  const angularFields = extractAngularOutputs(sourceText, events, seen);

  // A declared event sits where it is first emitted: the function around that line is what a parent's handler follows,
  // and every other function emitting it runs that handler too.
  const lines = lineIndex(sourceText);
  const emittedAt = new Map<string, number[]>();
  const record = (name: string, offset: number) => {
    const at = emittedAt.get(name) ?? emittedAt.set(name, []).get(name)!;
    const line = lineOf(lines, offset);
    if (at[at.length - 1] !== line) at.push(line);
  };
  for (const m of sourceText.matchAll(EMIT_CALL_RE)) record(m[1]!, m.index!);
  for (const [name, field] of angularFields) for (const m of sourceText.matchAll(outputEmitRe(field))) record(name, m.index!);
  for (const e of events) {
    const at = emittedAt.get(e.name);
    if (!at) continue;
    e.line = at[0]!;
    if (at.length > 1) e.sites = at;
  }

  return events;
}

/** An event name: `save`, `update:task`, `update:model-value`. */
const EVENT_NAME = String.raw`([\w:-]+)`;
const EMIT_CALL_RE = new RegExp(String.raw`\bemit\s*\(\s*['"]` + EVENT_NAME + `['"]`, "g");

/**
 * Parse call-signature form:
 *   defineEmits<{
 *     (e: 'refresh'): void;
 *     (e: 'select', id: number): void;
 *   }>()
 */
function extractDefineEmitsCallSignatures(
  source: string,
  events: EventInfo[],
  seen: Set<string>,
): void {
  // Match the defineEmits<{ ... }>() block
  const blockRe = /defineEmits\s*<\s*\{([\s\S]*?)\}\s*>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(source)) !== null) {
    const block = blockMatch[1];
    const blockStartOffset = blockMatch.index + blockMatch[0].indexOf(block);

    // Match each call signature: (e: 'eventName', param: type, ...): returnType —
    // one signature may declare several events (`e: 'create-one' | 'edit-one'`).
    const sigRe = new RegExp(String.raw`\(\s*\w+\s*:\s*((?:['"][\w:-]+['"]\s*\|\s*)*['"][\w:-]+['"])(.*?)\)\s*:`, "g");
    let sigMatch: RegExpExecArray | null;

    while ((sigMatch = sigRe.exec(block)) !== null) {
      const params = parseCallSignatureParams(sigMatch[2]);
      const line = lineAt(source, blockStartOffset + sigMatch.index);
      for (const m of sigMatch[1].matchAll(new RegExp(`['"]` + EVENT_NAME + `['"]`, "g"))) {
        const name = m[1]!;
        if (seen.has(name)) continue;
        seen.add(name);
        events.push({ name, params, line });
      }
    }
  }
}

/**
 * Parse defineEmits(['name1', 'name2']) — array form
 */
function extractDefineEmitsArray(
  source: string,
  events: EventInfo[],
  seen: Set<string>,
): void {
  const arrRe = /defineEmits\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
  let arrMatch: RegExpExecArray | null;

  while ((arrMatch = arrRe.exec(source)) !== null) {
    const items = arrMatch[1];
    const itemRe = new RegExp(`['"]` + EVENT_NAME + `['"]`, "g");
    let itemMatch: RegExpExecArray | null;

    while ((itemMatch = itemRe.exec(items)) !== null) {
      const name = itemMatch[1];
      if (seen.has(name)) continue;
      seen.add(name);

      const line = lineAt(source, arrMatch.index);
      events.push({ name, params: [], line });
    }
  }
}

/**
 * Fallback: scan emit('eventName', ...) calls
 */
function extractEmitCalls(
  source: string,
  events: EventInfo[],
  seen: Set<string>,
): void {
  const callRe = new RegExp(EMIT_CALL_RE.source, "g");
  let callMatch: RegExpExecArray | null;

  while ((callMatch = callRe.exec(source)) !== null) {
    const name = callMatch[1];
    if (seen.has(name)) continue;
    seen.add(name);

    const line = lineAt(source, callMatch.index);
    events.push({ name, params: [], line });
  }
}

/**
 * An Angular component's outputs — `read = output<Chapter>()`,
 * `@Output() deleted = new EventEmitter<number>()`, `@Output('removed') remove = …`
 * (the alias is the event a parent binds) — each placed where the class first
 * emits it (`this.read.emit(…)`), else at its declaration.
 */
function extractAngularOutputs(source: string, events: EventInfo[], seen: Set<string>): Map<string, string> {
  const fields = new Map<string, string>();
  if (!/from\s+['"]@angular\/core['"]/.test(source)) return fields;
  const re = /(?:@Output\(\s*(?:['"]([\w-]+)['"])?\s*\)\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:[!?]?\s*:[^=;\n]+)?=?|(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(?:output|outputFromObservable)\s*(?:<[^>\n]*>)?\s*\()/g;
  for (const m of source.matchAll(re)) {
    const field = m[2] ?? m[3]!;
    const name = m[1] ?? field;
    if (seen.has(name)) continue;
    seen.add(name);
    fields.set(name, field);
    events.push({ name, params: [], line: lineAt(source, m.index!) });
  }
  return fields;
}

/** `this.read.emit(` (or `.next(`, an EventEmitter being a Subject) — where an Angular output held in `field` is emitted. */
function outputEmitRe(field: string): RegExp {
  return new RegExp(String.raw`\b(?:this\.)?` + escapeRegex(field) + String.raw`\.(?:emit|next)\s*\(`, "g");
}

/**
 * Parse comma-separated params after the event name in a call signature.
 * Input example: ", id: number, label: string"
 */
function parseCallSignatureParams(raw: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  if (!raw || !raw.trim()) return params;

  // Split by comma, skip leading comma
  const parts = raw.split(",").slice(1); // first element is empty (before first param)

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      params.push({ name: trimmed, type: null, defaultValue: null });
    } else {
      const name = trimmed.slice(0, colonIdx).trim();
      const type = trimmed.slice(colonIdx + 1).trim() || null;
      params.push({ name, type, defaultValue: null });
    }
  }

  return params;
}

/** The offset each line starts at. */
function lineIndex(source: string): number[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** The 1-based line of an offset, by binary search over `lineIndex`. */
function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Get 1-based line number for a character offset */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}
