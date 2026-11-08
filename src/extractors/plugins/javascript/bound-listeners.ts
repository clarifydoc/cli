import type { InteractiveElementInfo } from "../../../types/analysis.js";

/**
 * Listeners handed to a component as one object: `<ClubDialog v-bind="bindings" />` with
 * `const bindings = computed(() => ({ onConfirm: () => emit('confirm'), onCancel: close, onDelete }))`.
 * Vue reads an `onX` key of a bound object as the `@x` binding, so each is the element a written
 * `@confirm="…"` would be — the parent's handler for the event the child emits. Only a literal object the
 * script declares (`const x = { … }`, `computed(() => ({ … }))`, `reactive({ … })`), only `on` + a capital.
 */
export function boundListeners(template: string, raw: string, script: string): InteractiveElementInfo[] {
  if (!/\bv-bind\s*=/.test(template)) return [];
  const templateStart = raw.indexOf(template);
  const out: InteractiveElementInfo[] = [];
  const tagRegex = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?\s*>/g;
  for (let tag = tagRegex.exec(template); tag; tag = tagRegex.exec(template)) {
    const name = /(?:^|\s)v-bind\s*=\s*(?:"([A-Za-z_$][\w$]*)"|'([A-Za-z_$][\w$]*)')/.exec(tag[2] ?? "");
    // A lower-case tag is an element; a component's is written `ClubDialog` or `club-dialog`.
    if (!name || /^(?:[a-z]+)$/.test(tag[1]!) || /^(?:template|slot|component)$/.test(tag[1]!)) continue;
    const object = objectLiteral(script, name[1] ?? name[2]!);
    if (!object) continue;
    const line = (raw.slice(0, templateStart + tag.index).match(/\n/g)?.length ?? 0) + 1;
    for (const [key, handler] of listenersOf(object)) {
      // A written `@confirm` on the tag wins over the object's key.
      if (new RegExp(`(?:^|\\s)(?:@|v-on:)${key}(?:[.=\\s]|$)`, "i").test(tag[2] ?? "")) continue;
      out.push({ element: "custom", event: `@${key}`, handler, line, component: tag[1]! });
    }
  }
  return out;
}

/** The body of the object literal a script binds to `name` (`const name = { … }`, `computed(() => ({ … }))`, `reactive({ … })`). */
function objectLiteral(script: string, name: string): string | undefined {
  const decl = new RegExp(`(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=\\n]+)?=\\s*(?:computed\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\(?\\s*|reactive\\s*\\(\\s*)?\\{`).exec(script);
  if (!decl) return undefined;
  const open = decl.index + decl[0].length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      if (--depth === 0) return script.slice(open + 1, i);
    }
  }
  return undefined;
}

/** `[event, handler]` of each `onX` entry: an arrow or function (as written), a bare name (`onSubmit: save`), or a shorthand (`onCancel`). */
function listenersOf(body: string): Array<[string, string]> {
  const entries: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      entries.push(body.slice(from, i));
      from = i + 1;
    }
  }
  entries.push(body.slice(from));
  const out: Array<[string, string]> = [];
  for (const entry of entries) {
    const m = /^\s*(?:\/\/[^\n]*\n\s*)*(on[A-Z][\w$]*)\s*(?::\s*([\s\S]+?))?\s*$/.exec(entry);
    if (!m) continue;
    const value = m[2] ?? m[1]!;
    // The event: `onConfirm` → `confirm`, `onUpdateModelValue` → `updateModelValue`.
    const key = m[1]!.slice(2).replace(/^[A-Z]/, (c) => c.toLowerCase());
    if (/^(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>|^(?:async\s+)?function\b|^[A-Za-z_$][\w$.]*$/.test(value)) out.push([key, value]);
  }
  return out;
}
