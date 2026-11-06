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

/** The scopes in force at each opening tag of `template`, keyed by the tag's offset (its own `v-for` included). */
export function templateScopes(template: string): Map<number, TemplateScope[]> {
  const out = new Map<number, TemplateScope[]>();
  if (!/\bv-for\s*=|\bv-slot\b|\s#[\w-]+|\sv-slot:/.test(template)) return out;
  const stack: Array<{ tag: string; scopes: TemplateScope[]; custom: boolean }> = [];
  const tagRegex = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>/g;
  for (let m = tagRegex.exec(template); m; m = tagRegex.exec(template)) {
    const tag = m[2]!;
    if (m[1]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag === tag) {
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
    if (!m[4] && !VOID.has(tag.toLowerCase())) stack.push({ tag, scopes, custom });
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
