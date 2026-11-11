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
  sourceText = emitConstants(sourceText);

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

/**
 * `emit(UPLOAD)` with `const UPLOAD = "upload"` declared in the file: the call as the literal it names
 * (line breaks kept, so every offset still falls on its own line). A name the file does not bind to a string
 * literal, or binds twice, is left as written.
 */
export function emitConstants(source: string): string {
  if (!/\bemit\s*\(\s*[A-Za-z_$]/.test(source)) return source;
  const consts = new Map<string, string | null>();
  for (const m of source.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:(['"])([\w:-]+)\2(?:\s+as\s+const)?\s*;?\s*$|[^\n]*)/gm)) {
    consts.set(m[1]!, consts.has(m[1]!) ? null : m[3] ?? null);
  }
  return source.replace(/\bemit\s*\(\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/g, (all, name: string) => {
    const value = consts.get(name);
    return value ? all.replace(name, `"${value}"`) : all;
  });
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
 * An Angular component's outputs — `read = output<Fixture>()` (a type argument may span lines and nest:
 * `output<{ page: number; part: string }>()`, `output<Array<Club>>()`),
 * `@Output() deleted = new EventEmitter<number>()`, `@Output('removed') remove = …`
 * (the alias is the event a parent binds) — each placed where the class first
 * emits it (`this.read.emit(…)`), else at its declaration.
 */
function extractAngularOutputs(source: string, events: EventInfo[], seen: Set<string>): Map<string, string> {
  const fields = new Map<string, string>();
  if (!/from\s+['"]@angular\/core['"]/.test(source)) return fields;
  const re = /(?:@Output\(\s*(?:['"]([\w-]+)['"])?\s*\)\s*(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:[!?]?\s*:[^=;\n]+)?=?|(?:(?:public|private|protected|readonly)\s+)*([A-Za-z_$][\w$]*)\s*=\s*(?:output|outputFromObservable)\s*(?:<[\s\S]{0,600}?>)?\s*\()/g;
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

/**
 * The lines where a component emits an event it does not name by a literal (`$emit(btn.event)`,
 * `emit(item.event)`, `(childEvent) => $emit(childEvent)`) — after the constants a file binds to strings
 * (`emit(UPLOAD)`) are read as those strings — and the strings it gives an `event` key.
 */
export function dynamicEmitFacts(source: string): { lines: number[]; literals: string[] } {
  const text = emitConstants(source);
  const lines: number[] = [];
  if (/\bemit\s*\(/.test(text)) {
    const starts = lineIndex(text);
    for (const m of text.matchAll(/(?:\$emit|(?<![\w$.])emit)\s*\(\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*[,)]/g)) lines.push(lineOf(starts, m.index!));
  }
  const literals = [...new Set([...source.matchAll(/(?<![\w$])event\s*:\s*['"]([\w:-]+)['"]/g)].map((m) => m[1]!))];
  return { lines: [...new Set(lines)], literals };
}

/** The text a script gives `name` (`const buttons = [ … ]`, `const actions = computed(() => [ … ])`), through the end of its statement. */
function declarationText(script: string, name: string): string {
  const head = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(name)}\\b[^=\\n]*=`).exec(script);
  if (!head) return "";
  const start = head.index + head[0].length;
  let depth = 0;
  let quote = "";
  for (let i = start; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth <= 0 && (c === ";" || (c === "\n" && !/(?:=>|[,=?:+|&(])\s*$/.test(script.slice(start, i))))) return script.slice(start, i);
  }
  return script.slice(start);
}

/**
 * The strings a template gives each component tag through its bindings (`<ButtonGroup :buttons="buttons">`):
 * the `event: 'x'` literals of the binding's expression and of the script declarations it names. A child
 * that emits by data emits only these for that tag — never another tag's, nor an unrelated array in the file.
 */
export function tagEventLiterals(template: string, script: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!/(?:^|\s)(?::|v-bind)/.test(template)) return out;
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/g;
  for (let m = tagRegex.exec(template); m; m = tagRegex.exec(template)) {
    const found = new Set<string>();
    for (const b of (m[2] ?? "").matchAll(/(?:^|\s)(?::[\w.-]+|v-bind(?::[\w.-]+)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      // The expression, and the script declarations it names, followed through what they name (three deep).
      const seen = new Set<string>();
      const read = (text: string, depth: number): void => {
        for (const l of text.matchAll(/(?<![\w$])event\s*:\s*['"]([\w:-]+)['"]/g)) found.add(l[1]!);
        if (depth >= 3) return;
        for (const id of new Set(text.replace(/\.\.\./g, " ").match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? [])) {
          if (seen.has(id)) continue;
          seen.add(id);
          const decl = declarationText(script, id);
          if (decl) read(decl, depth + 1);
        }
      };
      read(b[1] ?? b[2] ?? "", 0);
    }
    if (found.size > 0) out[m[1]!] = [...new Set([...(out[m[1]!] ?? []), ...found])];
  }
  return out;
}
