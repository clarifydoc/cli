/**
 * What a Vue component declares about itself: the props it takes and the events it emits —
 * `defineProps` / `defineEmits` (array, object, type-only and 3.3 shorthand forms, `withDefaults`)
 * and the Options API `props:` / `emits:` keys. Read off the script's text with balanced scanning,
 * names as written; absent (`undefined`) where the component declares nothing, so "declares no
 * emits" is never confused with "declares an empty list".
 */
export interface VueDeclarations {
  props?: string[];
  emits?: string[];
}

const OPEN = "([{<";
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/** Index just past the bracket closing the one at `open`, skipping strings; `=>` is no `>`. -1 when unbalanced. */
function closeOf(s: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
      continue;
    }
    if (c === ">" && s[i - 1] === "=") continue;
    if (OPEN.includes(c)) stack.push(CLOSE[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** The top-level pieces of a bracket body, split at `,`/`;`/newline outside nested brackets and strings. */
function topLevel(body: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < body.length && body[i] !== c; i++) if (body[i] === "\\") i++;
      continue;
    }
    // `<` opens only after a name (a generic); `>` closes only such a `<` — never `=>` or a comparison.
    if (c === "<") {
      if (/[\w$]/.test(body[i - 1] ?? "")) stack.push(">");
    } else if (c === ">") {
      if (body[i - 1] !== "=" && stack[stack.length - 1] === ">") stack.pop();
    } else if ("([{".includes(c)) stack.push(CLOSE[c]!);
    else if (c === stack[stack.length - 1]) stack.pop();
    else if (stack.length === 0 && (c === "," || c === ";" || c === "\n")) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Property names of an object-literal / type-literal body: the key before each top-level `:`, `?:`, `(`, `<` or `,`. */
function keysOf(body: string): string[] {
  const keys: string[] = [];
  for (const piece of topLevel(body)) {
    const m = /^(?:readonly\s+)?(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$-]*))\s*\??\s*(?:[:(<]|$)/.exec(piece);
    const key = m?.[1] ?? m?.[2] ?? m?.[3];
    if (key) keys.push(key);
  }
  return keys;
}

/** String literals of an array body. */
function stringsOf(body: string): string[] {
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2])!).filter(Boolean);
}

/** The first argument or type argument of `name` (a `defineX` call): its bracket body. */
function callBody(src: string, name: string): { kind: "array" | "object" | "type"; body: string } | undefined {
  const re = new RegExp(`\\b${name}\\s*(<|\\()`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let at = m.index + m[0].length - 1;
    if (m[1] === "<") {
      const end = closeOf(src, at);
      if (end < 0) continue;
      const inner = src.slice(at + 1, end - 1).trim();
      if (inner.startsWith("{")) return { kind: "type", body: inner.slice(1, inner.lastIndexOf("}")) };
      continue; // a named type: its members are another file's or another place's to read
    }
    const end = closeOf(src, at);
    if (end < 0) continue;
    const arg = src.slice(at + 1, end - 1).trim();
    if (arg.startsWith("[")) return { kind: "array", body: arg.slice(1, arg.lastIndexOf("]")) };
    if (arg.startsWith("{")) return { kind: "object", body: arg.slice(1, arg.lastIndexOf("}")) };
    if (arg === "") continue;
  }
  return undefined;
}

function names(spec: { kind: "array" | "object" | "type"; body: string } | undefined, emits: boolean): string[] | undefined {
  if (!spec) return undefined;
  if (spec.kind === "array") return stringsOf(spec.body);
  if (spec.kind === "object") return keysOf(spec.body);
  if (!emits) return keysOf(spec.body);
  // `(e: 'save' | 'sell', id: number): void` signatures and the `save: [id: number]` shorthand.
  const out: string[] = [];
  for (const piece of topLevel(spec.body)) {
    if (piece.startsWith("(")) {
      const end = closeOf(piece, 0);
      const first = end > 0 ? topLevel(piece.slice(1, end - 1))[0] : undefined;
      const t = first ? /^\w+\s*:\s*([^]*)$/.exec(first)?.[1] : undefined;
      if (t) out.push(...stringsOf(t));
    } else out.push(...keysOf(piece));
  }
  return out;
}

/** The value of an Options API key (`props:` / `emits:`) in the file's default-exported object. */
function optionsKey(src: string, key: string): { kind: "array" | "object"; body: string } | undefined {
  const m = new RegExp(`(?:^|[{,;\\s])${key}\\s*:\\s*([\\[{])`).exec(src);
  if (!m) return undefined;
  const at = m.index + m[0].length - 1;
  const end = closeOf(src, at);
  if (end < 0) return undefined;
  return { kind: m[1] === "[" ? "array" : "object", body: src.slice(at + 1, end - 1) };
}

export function readVueDeclarations(script: string): VueDeclarations {
  const out: VueDeclarations = {};
  const props = names(callBody(script, "defineProps"), false) ?? names(optionsKey(script, "props"), false);
  const emits = names(callBody(script, "defineEmits"), true) ?? names(optionsKey(script, "emits"), true);
  if (props) out.props = [...new Set(props)];
  if (emits) out.emits = [...new Set(emits)];
  return out;
}
