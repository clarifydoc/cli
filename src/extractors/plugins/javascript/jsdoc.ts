import type { Node } from "web-tree-sitter";

/**
 * JSDoc type annotations — how plain JavaScript declares the types the
 * linker follows (`@param {UserRepo} repo`, `@type {Clock}`, `@implements
 * {AuditLog}`, `@interface`). Read only from the `/** … *\/` comment directly
 * preceding a declaration; a TypeScript annotation on the same declaration
 * always wins over it.
 */

/**
 * The JSDoc block directly before `node` — skipping its decorators, and
 * stepping out of an `export` (whose statement the comment precedes). Null
 * when the previous sibling is anything but a `/**` comment.
 */
export function precedingJsDoc(node: Node): string | null {
  let target: Node = node;
  if (target.parent?.type === "export_statement") target = target.parent;
  let prev = target.previousNamedSibling;
  while (prev && prev.type === "decorator") prev = prev.previousNamedSibling;
  if (prev?.type !== "comment") return null;
  const text = prev.text;
  return text.startsWith("/**") ? text : null;
}

/** An unbalanced `{` must not scan the rest of a long comment. */
const MAX_JSDOC_TYPE_LENGTH = 400;

/**
 * The `{…}` type expression after a tag at `from`, braces balanced
 * (`{{ id: number }}`, `{Map<string, {a: B}>}`), with the index after it.
 */
function bracedType(text: string, from: number): { type: string; end: number } | null {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text[i] !== "{") return null;
  let depth = 0;
  const stop = Math.min(text.length, i + MAX_JSDOC_TYPE_LENGTH);
  for (let j = i; j < stop; j++) {
    const ch = text[j];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return { type: text.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/**
 * A JSDoc type as the type text the linker reads: `import('./x.js').UserRepo`
 * → `UserRepo`, `?T` / `!T` (nullable / non-null) → `T`, `T=` (optional
 * parameter) → `T`. Unknown `*` / `?` and rest types (`...T`) state no
 * receiver type → null. Everything else is kept as written.
 */
export function normalizeJsDocType(raw: string): string | null {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/\bimport\(\s*(['"])[^'"]*\1\s*\)\./g, "");
  t = t.replace(/^[?!]+/, "").replace(/=$/, "").trim();
  if (!t || t === "*" || t === "?" || t.startsWith("...")) return null;
  return t;
}

/** `@param {T} name` (also `[name]`, `[name=default]`) → name → T. Dotted names (`opts.x`) describe members, not parameters. */
export function jsDocParamTypes(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@(?:param|arg|argument)\b/g;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    const braced = bracedType(doc, m.index + m[0].length);
    if (!braced) continue;
    const name = /^\s*\[?\s*([A-Za-z_$][\w$]*)(?![\w$.])/.exec(doc.slice(braced.end));
    if (!name) continue;
    const type = normalizeJsDocType(braced.type);
    if (type && !out.has(name[1]!)) out.set(name[1]!, type);
  }
  return out;
}

/** `@type {T}` → T. */
export function jsDocTypeTag(doc: string): string | null {
  const m = /@type\b/.exec(doc);
  if (!m) return null;
  const braced = bracedType(doc, m.index + m[0].length);
  return braced ? normalizeJsDocType(braced.type) : null;
}

/** Every `@implements {I}` → the bare interface names (type arguments dropped). */
export function jsDocImplements(doc: string): string[] {
  const out: string[] = [];
  const re = /@implements\b/g;
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    const braced = bracedType(doc, m.index + m[0].length);
    const type = braced ? normalizeJsDocType(braced.type) : null;
    if (!type) continue;
    const bare = type.replace(/<.*$/s, "").trim();
    if (/^[A-Za-z_$][\w$.]*$/.test(bare)) out.push(bare);
  }
  return out;
}

/** A class documented as `@interface` — Closure/JSDoc's way of declaring one in plain JS. */
export function jsDocIsInterface(doc: string): boolean {
  return /@interface\b/.test(doc);
}
