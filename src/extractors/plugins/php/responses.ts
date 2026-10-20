import type { RouteResponseInfo } from "../../../types/analysis.js";
import { statusCode } from "../shared/http-status.js";

/**
 * What a PHP controller action answers, read off its body text:
 *
 *   return response()->json($order, 201);                        Laravel → 201
 *   return response()->json(['id' => $o->id, 'total' => $t]);    → keys [id, total]
 *   return response()->noContent();                              → 204
 *   return new OrderResource($order);  OrderResource::collection($orders)   → type (list)
 *   return $this->json($data, Response::HTTP_CREATED);           Symfony → 201
 *   return new JsonResponse(['ok' => true], 202);
 */

/** Top-level `'key' =>` keys of a PHP array literal's text, sorted; undefined when not one. */
function arrayKeys(expr: string): string[] | undefined {
  const t = expr.trim();
  const inner = t.startsWith("[") ? t.slice(1, t.lastIndexOf("]")) : /^array\s*\(/.test(t) ? t.slice(t.indexOf("(") + 1, t.lastIndexOf(")")) : null;
  if (inner === null) return undefined;
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  const take = (part: string) => {
    const m = /^\s*['"]([^'"]+)['"]\s*=>/.exec(part);
    if (m) keys.push(m[1]!);
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" || ch === '"') {
      const end = inner.indexOf(ch, i + 1);
      if (end > i) i = end;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      take(inner.slice(start, i));
      start = i + 1;
    }
  }
  take(inner.slice(start));
  return keys.length ? [...new Set(keys)].sort() : undefined;
}

/** The argument text of the call whose `(` is at `open`, split at top-level commas. */
function callArgs(text: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end > i) i = end;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) {
        if (text.slice(start, i).trim()) out.push(text.slice(start, i).trim());
        return out;
      }
    } else if (ch === "," && depth === 1) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out;
}

export function extractPhpResponses(body: string): RouteResponseInfo[] {
  if (!/json|Resource|noContent|JsonResponse/.test(body)) return [];
  const out: RouteResponseInfo[] = [];
  const seen = new Set<string>();
  const add = (r: RouteResponseInfo) => {
    const k = JSON.stringify(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  };
  const shape = (expr: string | undefined): Pick<RouteResponseInfo, "type" | "keys"> => {
    if (!expr) return {};
    const keys = arrayKeys(expr);
    if (keys) return { keys };
    const res = /^new\s+\\?(?:[\w\\]+\\)?(\w+)\s*\(/.exec(expr) ?? /^\\?(?:[\w\\]+\\)?(\w+Resource)::make\(/.exec(expr);
    if (res) return { type: res[1]! };
    const coll = /^\\?(?:[\w\\]+\\)?(\w+)::collection\(/.exec(expr);
    return coll ? { type: `${coll[1]}[]` } : {};
  };
  for (const m of body.matchAll(/response\(\s*\)\s*->\s*json\s*\(|\$this\s*->\s*json\s*\(|new\s+\\?(?:[\w\\]+\\)?JsonResponse\s*\(/g)) {
    const args = callArgs(body, m.index! + m[0].length - 1);
    add({ status: statusCode(args[1] ?? null), ...shape(args[0]) });
  }
  if (/response\(\s*\)\s*->\s*noContent\s*\(/.test(body)) add({ status: 204 });
  for (const m of body.matchAll(/\breturn\s+(new\s+\\?(?:[\w\\]+\\)?\w+Resource\s*\(|\\?(?:[\w\\]+\\)?\w+Resource::(?:collection|make)\s*\()/g)) {
    add({ status: null, ...shape(m[1]!) });
  }
  return out;
}
