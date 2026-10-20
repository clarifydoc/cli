import type { Node } from "web-tree-sitter";

/**
 * The top-level fields a caller reads off a response body, followed through
 * the bindings of the statement block the call is in:
 *
 *   const res = await fetch(url); const { items, total } = await res.json();   → items, total
 *   const res = await fetch(url); const body = await res.json(); body.items     → items
 *   const { data } = await axios.get(url); data.user                            → user
 *   const res = await api.get(url); res.data.total                              → total
 *   const users = await $fetch(url); users.count                                → count
 *
 * `style` is how the client hands the body over: `.json()` on a fetch-like
 * response, `.data` on an axios-like one, or the value itself. Array and
 * promise members (`length`, `map`, `then`) are not fields. Absent when the
 * body is not bound here — returned, passed on, or chained in `.then`.
 */

export type BodyStyle = "json" | "data" | "direct";

const NOT_FIELDS = new Set([
  "length", "map", "filter", "forEach", "find", "findIndex", "some", "every", "reduce", "slice", "includes", "indexOf",
  "push", "sort", "concat", "join", "flat", "flatMap", "at", "entries", "keys", "values", "then", "catch", "finally",
  "toString", "valueOf",
]);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The binding a declaration makes of an awaited expression: a name, or destructured keys (with their local names). */
function bindingOf(decl: Node): { name?: string; keys?: Array<{ key: string; local: string | null }> } | null {
  const pattern = decl.childForFieldName("name");
  if (!pattern) return null;
  if (pattern.type === "identifier") return { name: pattern.text };
  if (pattern.type !== "object_pattern") return null;
  const keys: Array<{ key: string; local: string | null }> = [];
  for (const p of pattern.namedChildren) {
    if (p.type === "shorthand_property_identifier_pattern") keys.push({ key: p.text, local: p.text });
    else if (p.type === "pair_pattern") {
      const k = p.childForFieldName("key")?.text;
      const v = p.childForFieldName("value");
      if (k) keys.push({ key: k, local: v?.type === "identifier" ? v.text : null });
    } else if (p.type === "object_assignment_pattern") {
      const left = p.childForFieldName("left");
      if (left) keys.push({ key: left.text, local: left.text });
    }
  }
  return { keys };
}

/** The declarator whose value is `node`, possibly awaited or parenthesized. */
function declaratorOf(node: Node): Node | null {
  let n: Node | null = node.parent;
  while (n && (n.type === "await_expression" || n.type === "parenthesized_expression")) n = n.parent;
  return n?.type === "variable_declarator" ? n : null;
}

/** Fields read as `name.x` / `name?.x` in `text`. */
function readsOf(text: string, name: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${esc(name)}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) out.push(m[1]!);
  return out;
}

export function responseReadsOf(call: Node, style: BodyStyle): string[] | undefined {
  const decl = declaratorOf(call);
  if (!decl) return undefined;
  let block: Node | null = decl.parent;
  while (block && block.type !== "statement_block" && block.type !== "program") block = block.parent;
  if (!block) return undefined;
  const text = block.text.slice(decl.endIndex - block.startIndex);
  const bound = bindingOf(decl);
  if (!bound) return undefined;

  const fields: string[] = [];
  const bodyNamed = (name: string) => fields.push(...readsOf(text, name));
  if (style === "direct") {
    if (bound.name) bodyNamed(bound.name);
    else for (const k of bound.keys ?? []) fields.push(k.key);
  } else if (style === "data") {
    if (bound.name) {
      // `res.data.total`, and `const x = res.data` / `const { a } = res.data`.
      fields.push(...readsOf(text, `${bound.name}.data`));
      for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+|\\{[^}]*\\})\\s*=\\s*${esc(bound.name)}\\.data\\b(?!\\.)`, "g"))) {
        if (m[1]!.startsWith("{")) fields.push(...m[1]!.slice(1, -1).split(",").map((p) => p.split(":")[0]!.trim()).filter(Boolean));
        else bodyNamed(m[1]!);
      }
    } else {
      for (const k of bound.keys ?? []) {
        if (k.key === "data" && k.local) bodyNamed(k.local);
      }
    }
  } else if (bound.name) {
    // fetch: the body is whatever `await res.json()` is bound to.
    for (const m of text.matchAll(new RegExp(`(?:const|let|var)\\s+(\\w+|\\{[^}]*\\})\\s*=\\s*await\\s+${esc(bound.name)}\\.json\\(\\s*\\)`, "g"))) {
      if (m[1]!.startsWith("{")) fields.push(...m[1]!.slice(1, -1).split(",").map((p) => p.split(":")[0]!.trim().replace(/\s*=.*$/, "")).filter(Boolean));
      else bodyNamed(m[1]!);
    }
  }
  const out = [...new Set(fields.filter((f) => f && !NOT_FIELDS.has(f) && /^[A-Za-z_$][\w$]*$/.test(f)))].sort();
  return out.length > 0 ? out : undefined;
}
