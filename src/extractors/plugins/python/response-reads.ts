import type { Node } from "web-tree-sitter";

/**
 * The top-level fields a Python caller reads off a JSON response, followed
 * through the bindings of the function the call is in:
 *
 *   requests.get(url).json()["items"]                          → items
 *   resp = requests.get(url); resp.json()["total"]             → total
 *   data = httpx.get(url).json(); data["items"], data.get("next")   → items, next
 *   resp = await client.get(url); body = resp.json(); body["id"]    → id
 *
 * Absent when the body is not read here (returned, passed on).
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `["x"]` / `.get("x")` subscripts off `expr` in `text`. */
function keysReadOff(text: string, expr: string): string[] {
  const e = esc(expr);
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`${e}\s*\[\s*["']([\w-]+)["']\s*\]`, "g"))) out.push(m[1]!);
  for (const m of text.matchAll(new RegExp(String.raw`${e}\s*\.get\(\s*["']([\w-]+)["']`, "g"))) out.push(m[1]!);
  return out;
}

export function pythonResponseReads(call: Node): string[] | undefined {
  // The statement the call sits in, and the function (or module) around it.
  let stmt: Node | null = call;
  while (stmt && stmt.parent && !/^(?:block|module)$/.test(stmt.parent.type)) stmt = stmt.parent;
  let scope: Node | null = stmt?.parent ?? null;
  while (scope && scope.type !== "function_definition" && scope.type !== "module") scope = scope.parent;
  if (!stmt || !scope) return undefined;
  const scopeText = scope.text;
  const reads = new Set<string>();

  // Read straight off the call: `requests.get(url).json()["items"]`.
  let up: Node | null = call.parent;
  while (up?.type === "await") up = up.parent;
  if (up?.type === "attribute" && up.childForFieldName("attribute")?.text === "json" && up.parent?.type === "call") {
    for (const k of keysReadOff(stmt.text, up.parent.text)) reads.add(k);
  }

  // Bound: `resp = requests.get(url)` or `data = requests.get(url).json()`.
  const assign = stmt.namedChildren[0]?.type === "assignment" ? stmt.namedChildren[0] : null;
  const target = assign?.childForFieldName("left");
  if (target?.type === "identifier") {
    const right = assign!.childForFieldName("right")?.text.replace(/^await\s+/, "") ?? "";
    const isBody = /\.json\(\s*\)\s*$/.test(right);
    const after = scopeText.slice(Math.max(0, scopeText.indexOf(stmt.text) + stmt.text.length));
    if (isBody) {
      for (const k of keysReadOff(after, target.text)) reads.add(k);
    } else {
      // `resp.json()["x"]`, or `body = resp.json()` and then `body["x"]`.
      for (const k of keysReadOff(after, `${target.text}.json()`)) reads.add(k);
      for (const m of after.matchAll(new RegExp(String.raw`\b(\w+)\s*=\s*(?:await\s+)?${esc(target.text)}\.json\(\s*\)`, "g"))) {
        for (const k of keysReadOff(after.slice(m.index! + m[0].length), m[1]!)) reads.add(k);
      }
    }
  }
  return reads.size > 0 ? [...reads].sort() : undefined;
}
