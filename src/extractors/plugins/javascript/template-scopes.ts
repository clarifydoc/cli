import { blankStringAwareComments } from "../shared/text-scan.js";
/**
 * The names a Vue template binds below an element, which its handlers read as if they were the
 * component's own: a `v-for` loop variable (`club` in `v-for="club in clubs"`) and a scoped slot's
 * parameters (`save` in `<template #default="{ save }">`). Without them `club.archive()` is a call
 * on a name nothing declares and `save(club)` reads as the component's own `save`.
 */
export interface TemplateScope {
  kind: "loop" | "slot";
  /** The local names this scope binds. */
  names: string[];
  /** Loop: the collection expression as written (`clubs`, `props.clubs`). */
  source?: string;
  /** Slot: the component whose slot it is, the slot's name, and each local's prop (`{ save: "save" }`, `{ onSave: "save" }` for `{ save: onSave }`). */
  component?: string;
  slot?: string;
  props?: Record<string, string>;
  /** Slot: the whole props object bound to one name (`#default="props"`); `names` holds that name and `props` is empty. */
  whole?: boolean;
}

/** `scope.slot.prop` of a scope that binds the slot's whole props object: the member comes from the call (`props.save`). */
export const WHOLE_SLOT_PROPS = "*";

const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

/** The element carrying a `v-for`: the loop it binds and the template offsets its element spans (`end` exclusive). */
export interface LoopExtent {
  scope: TemplateScope;
  start: number;
  end: number;
}

/** The scopes in force at each opening tag of `template`, keyed by the tag's offset (its own `v-for` included). */
export function templateScopes(template: string, loops?: LoopExtent[]): Map<number, TemplateScope[]> {
  const out = new Map<number, TemplateScope[]>();
  if (!/\bv-for\s*=|\bv-slot\b|\s#[\w-]+|\sv-slot:/.test(template)) return out;
  const stack: Array<{ tag: string; scopes: TemplateScope[]; custom: boolean; extent?: LoopExtent }> = [];
  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g;
  for (let m = tagRegex.exec(template); m; m = tagRegex.exec(template)) {
    const tag = m[2]!;
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) {
          // The element ends where its closing tag does; one never closed keeps its own opening tag.
          const closed = stack[i]!.extent;
          if (closed) closed.end = m.index + m[0].length;
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = m[3] ?? "";
    const inherited = stack.length > 0 ? stack[stack.length - 1]!.scopes : [];
    const custom = /^[A-Z]/.test(tag) || tag.includes("-") || /[a-z][A-Z]/.test(tag);
    const own: TemplateScope[] = [];
    const loop = /(?:^|\s)v-for\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    if (loop) {
      const lp = /^\s*(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s+(?:in|of)\s+([\s\S]+?)\s*$/.exec(loop[1] ?? loop[2] ?? "");
      if (lp) {
        const names = (lp[1] ?? lp[2] ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
        if (names.length > 0) own.push({ kind: "loop", names, source: lp[3]! });
        if (names.length > 0 && loops) loops.push({ scope: own[own.length - 1]!, start: m.index, end: m.index + m[0].length });
      }
    }
    const slot = /(?:^|\s)(?:v-slot(?::([\w-]+))?|#([\w-]+))\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    if (slot) {
      const owner = tag === "template" ? [...stack].reverse().find((s) => s.custom)?.tag : custom ? tag : undefined;
      const raw = slot[3] ?? slot[4] ?? "";
      const props = slotParams(raw);
      if (owner && props) own.push({ kind: "slot", names: Object.keys(props), component: owner, slot: slot[1] ?? slot[2] ?? "default", props });
      // `#default="props"`: every prop of the slot under one name, read as `props.save`.
      else if (owner && /^\s*[A-Za-z_$][\w$]*\s*$/.test(raw)) own.push({ kind: "slot", names: [raw.trim()], component: owner, slot: slot[1] ?? slot[2] ?? "default", props: {}, whole: true });
    }
    const scopes = own.length > 0 ? [...inherited, ...own] : inherited;
    if (scopes.length > 0) out.set(m.index, scopes);
    if (!m[4] && !VOID.has(tag.toLowerCase())) stack.push({ tag, scopes, custom, ...(loop && loops && own.some((o) => o.kind === "loop") ? { extent: loops[loops.length - 1]! } : {}) });
  }
  return out;
}

/** `{ save, label: caption = "x" }` → `{ save: "save", caption: "label" }` (local → prop); a plain `props` is not read. */
function slotParams(raw: string): Record<string, string> | null {
  const t = raw.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return null;
  const out: Record<string, string> = {};
  for (const part of t.slice(1, -1).split(",")) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:=.*)?$/s.exec(part);
    if (m) out[m[2] ?? m[1]!] = m[1]!;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The loop variables a template binds whose collection is a plain name or member chain (`club in clubs`, `m of
 * props.matches`; the first name of `(club, i) in clubs` is the element), each with the type the script states
 * for the collection (`scriptType`) and the offsets of the element carrying the `v-for` — a variable is the
 * loop's inside that element only. Whether two loops of one name are told apart is the reader's, by extent.
 */
export function templateLoopVariables(template: string, script = ""): Array<{ name: string; source: string; sourceType?: string; start: number; end: number }> {
  if (!/\bv-for\s*=/.test(template)) return [];
  const extents: LoopExtent[] = [];
  templateScopes(template, extents);
  return extents.flatMap(({ scope: s, start, end }) => {
    if (!s.source || !/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(s.source)) return [];
    const source = s.source.replace(/\?\./g, ".");
    const sourceType = scriptType(script, source);
    return [{ name: s.names[0]!, source, ...(sourceType ? { sourceType } : {}), start, end }];
  });
}

/**
 * The type a `<script setup>` states for `chain` (a name, or `props.<name>`): `const clubs: Club[] = …` or
 * `ref<Club[]>(…)` at the script's top level, or a top-level member of `defineProps<{ clubs: Club[] }>()`. Null
 * when the script states none, states several (a name declared twice), or states one the reader cannot read cleanly
 * (an unbalanced `<…>`, a union continued on the next line).
 */
function scriptType(script: string, chain: string): string | null {
  const parts = chain.split(".");
  const name = parts.length === 2 && parts[0] === "props" ? parts[1]! : parts.length === 1 ? parts[0]! : null;
  if (!name || !script || !/^\w+$/.test(name)) return null;
  const types = new Set<string>();
  // Strings and comments blanked (same offsets), so a brace in one does not count as structure.
  const flat = blankStringsAndComments(script);
  const depthAt = depthMap(flat);
  const declared = new RegExp(`(?:const|let|var)\\s+${name}\\s*:\\s*`, "g");
  for (const m of flat.matchAll(declared)) {
    if (depthAt[m.index!] !== 0) continue;
    const type = readType(flat, script, m.index! + m[0].length, "=");
    if (type === undefined) return null;
    if (type) types.add(type);
  }
  const reffed = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:ref|shallowRef)\\s*<`, "g");
  for (const m of flat.matchAll(reffed)) {
    if (depthAt[m.index!] !== 0) continue;
    const type = balancedAngle(script, m.index! + m[0].length - 1);
    if (type) types.add(type);
  }
  const props = /defineProps\s*<\s*\{/.exec(flat);
  if (props && depthAt[props.index] === 0) {
    const open = props.index + props[0].length - 1;
    const close = balancedBraces(flat, open);
    if (close !== null) {
      const member = new RegExp(`(?:readonly\\s+)?${name}\\??\\s*:\\s*`, "y");
      const bodyFlat = flat.slice(open + 1, open + 1 + close.length);
      const bodyDepth = depthMap(bodyFlat);
      for (let i = 0; i < bodyFlat.length; i++) {
        // A member starts the body, or follows a `;`, `,` or newline at the body's own depth.
        if (bodyDepth[i] !== 0 || (i > 0 && !/[;,\n]/.test(bodyFlat[i - 1]!))) continue;
        let j = i;
        while (j < bodyFlat.length && /[ \t]/.test(bodyFlat[j]!)) j++;
        member.lastIndex = j;
        const hit = member.exec(bodyFlat);
        if (!hit) continue;
        const type = readType(bodyFlat, script.slice(open + 1, open + 1 + close.length), j + hit[0].length, ";,");
        if (type === undefined) return null;
        if (type) types.add(type);
      }
    }
  }
  return types.size === 1 ? [...types][0]! : null;
}

/** `text` with the insides of strings, template literals and comments replaced by spaces (newlines kept). */
const blankStringsAndComments = (text: string): string => blankStringAwareComments(text, { strings: "blank" });

/** The bracket depth (`{`, `(`, `[`) at each offset of `flat`. */
function depthMap(flat: string): Int32Array {
  const depth = new Int32Array(flat.length + 1);
  let d = 0;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i]!;
    if (ch === "}" || ch === ")" || ch === "]") d = Math.max(0, d - 1);
    depth[i] = d;
    if (ch === "{" || ch === "(" || ch === "[") d++;
  }
  depth[flat.length] = d;
  return depth;
}

/**
 * The type written at `from` up to the first of `stops` at depth 0 of `<>()[]{}` (`=>` is no `>` and no stop):
 * the original text of that span, trimmed. `undefined` when the reader cannot read it cleanly — unbalanced
 * brackets, no stop, a trailing operator, or a union/intersection continued on the next line.
 */
function readType(flat: string, original: string, from: number, stops: string): string | null | undefined {
  let depth = 0;
  for (let i = from; i < flat.length; i++) {
    const ch = flat[i]!;
    const arrow = ch === "=" && flat[i + 1] === ">";
    if (arrow) { i++; continue; }
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" && flat[i - 1] !== "=") depth--;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return stops.includes(",") || stops.includes(";") ? finishType(original, from, i, flat) : undefined;
    } else if (depth === 0 && stops.includes(ch)) return finishType(original, from, i, flat);
    else if (depth === 0 && ch === "\n") return finishType(original, from, i, flat);
    if (depth < 0) return undefined;
  }
  return stops.includes(",") || stops.includes(";") ? finishType(original, from, flat.length, flat) : undefined;
}

function finishType(original: string, from: number, to: number, flat: string): string | null | undefined {
  const type = original.slice(from, to).trim();
  if (!type) return undefined;
  if (/[|&<,(=:]$/.test(type)) return undefined;
  // A union or intersection that goes on at the next line is read in part: give none.
  if (/^\s*[|&]/.test(flat.slice(to, to + 80).replace(/^[;,]/, "").replace(/^\s+/, ""))) return undefined;
  return type;
}

/** The text between the `<` at `open` and its matching `>`. */
function balancedAngle(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<") depth++;
    else if (ch === ">" && text[i - 1] !== "=" && --depth === 0) return text.slice(open + 1, i).trim();
    else if (ch === "\n" && depth === 0) return null;
  }
  return null;
}

/** The text between the `{` at `open` and its matching `}`. */
function balancedBraces(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
