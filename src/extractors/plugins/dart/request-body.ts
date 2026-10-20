import type { JsonSchemaNode } from "../../../types/analysis.js";

/**
 * The body a Dart HTTP call sends, as far as the call states it:
 * package:http's `body: jsonEncode({...})` and Dio's `data: {...}` — a map
 * literal, or a local the function assigned one to earlier. Values are typed
 * by their literal; a spread (`...extra`) leaves the object open. Null when
 * the body is not stated.
 *
 *   await http.post(Uri.parse(url),
 *       headers: {'Content-Type': 'application/json'},
 *       body: jsonEncode({'name': name, 'age': 3}));
 */
export function dartRequestBody(lines: string[], lineIndex: number, callEnd: number): JsonSchemaNode | null {
  const args = callArguments(lines, lineIndex, callEnd);
  if (args === null) return null;
  const m = /\b(?:body\s*:\s*(?:json\.encode|jsonEncode)\s*\(|data\s*:\s*)/.exec(args);
  if (!m) return null;
  let value = leadingExpression(args.slice(m.index + m[0].length));
  const local = /^[A-Za-z_]\w*$/.exec(value)?.[0];
  if (local) value = localMap(lines, lineIndex, local) ?? "";
  return value.startsWith("{") ? mapSchema(value, 0) : null;
}

/** The call's argument text from just after its `(` to the matching `)`, across lines (at most 30). */
function callArguments(lines: string[], lineIndex: number, from: number): string | null {
  const text = lines.slice(lineIndex, lineIndex + 30).join("\n");
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return text.slice(from, i);
    }
  }
  return null;
}

/** The expression at the start of `text`, up to the comma or bracket that ends it at depth 0. */
function leadingExpression(text: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return text.slice(0, i).trim();
      depth--;
      if (depth === 0 && c === "}") return text.slice(0, i + 1).trim();
    } else if (c === "," && depth === 0) return text.slice(0, i).trim();
  }
  return text.trim();
}

/** The map literal a local was assigned within the 60 lines above (`final body = {...};`). */
function localMap(lines: string[], lineIndex: number, name: string): string | null {
  const re = new RegExp(String.raw`\b(?:final|var|const|Map<[^>]*>)\s+${name}\s*=\s*`);
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 60); i--) {
    const m = re.exec(lines[i] ?? "");
    if (!m) continue;
    const rest = [lines[i]!.slice(m.index + m[0].length), ...lines.slice(i + 1, i + 30)].join("\n");
    return rest.trimStart().startsWith("{") ? leadingExpression(rest.trimStart()) : null;
  }
  return null;
}

/** Top-level comma-separated parts of a bracketed literal's inside. */
function parts(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((p) => p.trim()).filter(Boolean);
}

function mapSchema(literal: string, depth: number): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  let open = false;
  for (const entry of parts(literal.slice(1, -1))) {
    if (entry.startsWith("...")) {
      open = true;
      continue;
    }
    const kv = /^(['"])([^'"$]+)\1\s*:\s*([\s\S]+)$/.exec(entry);
    if (kv) properties[kv[2]!] = valueSchema(kv[3]!.trim(), depth);
    else open = true;
  }
  return { type: "object", properties, ...(open ? { additionalProperties: true } : {}) };
}

function valueSchema(v: string, depth: number): JsonSchemaNode {
  if (depth > 4) return {};
  if (/^(['"]).*\1$/s.test(v)) return { type: "string" };
  if (/^-?\d+$/.test(v)) return { type: "integer" };
  if (/^-?\d+\.\d+$/.test(v)) return { type: "number" };
  if (v === "true" || v === "false") return { type: "boolean" };
  if (v === "null") return { nullable: true };
  if (v.startsWith("[") && v.endsWith("]")) {
    const first = parts(v.slice(1, -1))[0];
    return { type: "array", ...(first ? { items: valueSchema(first, depth + 1) } : {}) };
  }
  if (v.startsWith("{") && v.endsWith("}")) return mapSchema(v, depth + 1);
  return {};
}
