import type { EventInfo, ParamInfo, Language } from "../../../types/analysis.js";

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

  // A declared event sits where it is first emitted: the function around that line is what a parent's handler follows.
  const emittedAt = new Map<string, number>();
  for (const m of sourceText.matchAll(EMIT_CALL_RE)) if (!emittedAt.has(m[1]!)) emittedAt.set(m[1]!, lineAt(sourceText, m.index!));
  for (const e of events) e.line = emittedAt.get(e.name) ?? e.line;

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

    // Match each call signature: (e: 'eventName', param: type, ...): returnType
    const sigRe = new RegExp(String.raw`\(\s*\w+\s*:\s*['"]` + EVENT_NAME + String.raw`['"](.*?)\)\s*:`, "g");
    let sigMatch: RegExpExecArray | null;

    while ((sigMatch = sigRe.exec(block)) !== null) {
      const name = sigMatch[1];
      if (seen.has(name)) continue;
      seen.add(name);

      const params = parseCallSignatureParams(sigMatch[2]);
      const line = lineAt(source, blockStartOffset + sigMatch.index);

      events.push({ name, params, line });
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

/** Get 1-based line number for a character offset */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}
