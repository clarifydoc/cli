import type { Node } from "web-tree-sitter";

/**
 * The top-level fields a C# caller reads off a JSON response, followed
 * through the locals of the method the call is in:
 *
 *   var order = await _http.GetFromJsonAsync<OrderDto>(url);  order.Total, order?.Items  → total, items
 *   var resp = await _http.GetAsync(url);
 *   var dto = await resp.Content.ReadFromJsonAsync<OrderDto>(); dto.Id                  → id
 *
 * Names as `System.Text.Json`'s web defaults put them on the wire
 * (camelCase). A method called on the value (`order.ToString()`) is no field.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const camel = (s: string) => s[0]!.toLowerCase() + s.slice(1);

function propsReadOff(text: string, local: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`\b${esc(local)}\s*!?\??\.\s*([A-Z]\w*)\b(?!\s*[(<])`, "g"))) out.push(camel(m[1]!));
  return out;
}

export function csharpResponseReads(call: Node): string[] | undefined {
  let stmt: Node | null = call;
  while (stmt && !/_statement$|^local_declaration_statement$/.test(stmt.type)) stmt = stmt.parent;
  let scope: Node | null = stmt?.parent ?? null;
  while (scope && !/^(?:method_declaration|local_function_statement|constructor_declaration|lambda_expression|accessor_declaration)$/.test(scope.type)) scope = scope.parent;
  if (!stmt || !scope) return undefined;
  const local = /\b(?:var|[\w.<>?[\]]+)\s+(\w+)\s*=\s*(?:await\s+)?/.exec(stmt.text);
  if (!local || stmt.type !== "local_declaration_statement") return undefined;
  const scopeText = scope.text;
  const after = scopeText.slice(scopeText.indexOf(stmt.text) + stmt.text.length);
  const reads = new Set<string>();
  if (/GetFromJsonAsync\s*</.test(stmt.text)) {
    for (const r of propsReadOff(after, local[1]!)) reads.add(r);
  } else {
    // `var resp = await _http.GetAsync(url)`, then `var dto = await resp.Content.ReadFromJsonAsync<T>()`.
    for (const m of after.matchAll(new RegExp(String.raw`\b(\w+)\s*=\s*(?:await\s+)?${esc(local[1]!)}\.Content\.ReadFromJsonAsync\s*<`, "g"))) {
      for (const r of propsReadOff(after.slice(m.index! + m[0].length), m[1]!)) reads.add(r);
    }
  }
  return reads.size > 0 ? [...reads].sort() : undefined;
}
