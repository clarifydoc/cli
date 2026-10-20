import type { RouteResponseInfo } from "../../../types/analysis.js";
import { statusCode } from "../shared/http-status.js";

/**
 * What a Rails action or Sinatra block answers, read off its body:
 *
 *   render json: @user, status: :created           → 201, type User (when `@user = User.…` here)
 *   render json: { id: order.id, total: t }         → keys [id, total]
 *   render json: OrderSerializer.new(order)         → type OrderSerializer
 *   head :no_content                                → 204
 *   status 201; json(id: x.id)  /  { ok: true }.to_json   (Sinatra)
 *
 * Only JSON answers and bare statuses: `render :edit` renders a page.
 */

/** The top-level keys of a Ruby hash literal's text (`id: x`, `"id" => x`, `:id => x`), sorted; undefined when not a hash. */
function hashKeys(text: string): string[] | undefined {
  const t = text.trim();
  const inner = t.startsWith("{") ? t.slice(1, t.lastIndexOf("}")) : /^[a-z_]\w*:\s/.test(t) ? t : null;
  if (inner === null) return undefined;
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  const take = (part: string) => {
    const m = /^\s*(?:([a-z_]\w*[?!]?):(?!:)|["':]([\w-]+)["']?\s*=>)/i.exec(part);
    if (m) keys.push((m[1] ?? m[2])!);
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      take(inner.slice(start, i));
      start = i + 1;
    }
  }
  take(inner.slice(start));
  return keys.length ? [...new Set(keys)].sort() : undefined;
}

/** `render json: X, status: S` → [X, S] from the text after `render`. */
function renderArgs(rest: string): { json?: string; status?: string } {
  const out: { json?: string; status?: string } = {};
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(rest.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(rest.slice(start));
  for (const p of parts) {
    const m = /^\s*:?(json|status)\s*(?::|=>)\s*([\s\S]+)$/.exec(p);
    if (m) out[m[1] as "json" | "status"] = m[2]!.trim();
  }
  return out;
}

export function extractRubyResponses(bodyLines: string[]): RouteResponseInfo[] {
  const text = bodyLines.map((l) => l.replace(/#(?![{]).*$/, "")).join("\n");
  if (!/\b(?:render|head|status|json)\b|\.to_json\b/.test(text)) return [];
  // `@user = User.find(…)`, `order = Order.new(…)`: what a rendered variable is.
  const typeOf = new Map<string, string>();
  for (const m of text.matchAll(/(@?\w+)\s*=\s*([A-Z]\w*(?:::[A-Z]\w*)*)\.(?:find\w*|new|create!?|where|all|first|last|includes)\b/g)) typeOf.set(m[1]!, m[2]!.split("::").pop()!);
  const shape = (expr: string | undefined): Pick<RouteResponseInfo, "type" | "keys"> => {
    if (!expr) return {};
    const keys = hashKeys(expr);
    if (keys) return { keys };
    const ser = /^([A-Z]\w*(?:::[A-Z]\w*)*)\.new\b/.exec(expr);
    if (ser) return { type: ser[1]!.split("::").pop()! };
    const t = typeOf.get(expr.replace(/\.as_json\b.*$/, "").trim());
    return t ? { type: t } : {};
  };
  const out: RouteResponseInfo[] = [];
  const seen = new Set<string>();
  const add = (r: RouteResponseInfo) => {
    const k = JSON.stringify(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  };
  // One statement per logical line: join a `render` whose hash continues on the next lines.
  const statements = text.replace(/,\s*\n\s*/g, ", ").split("\n");
  const sinatraStatus = /^\s*status\s+\(?\s*(\d{3}|:\w+)/m.exec(text);
  for (const s of statements) {
    const render = /^\s*render\s*\(?\s*([\s\S]*?)\)?\s*$/.exec(s);
    if (render) {
      const a = renderArgs(render[1]!);
      if (a.json) add({ status: statusCode(a.status ?? null), ...shape(a.json) });
      continue;
    }
    const head = /^\s*head\s*\(?\s*(:\w+|\d{3})/.exec(s);
    if (head) {
      add({ status: statusCode(head[1]) });
      continue;
    }
    // Sinatra: `json(id: 1)` / `json obj`, or a hash `.to_json` as the block's value.
    const json = /^\s*(?:return\s+)?json\s*\(?\s*([\s\S]+?)\)?\s*$/.exec(s) ?? /^\s*(?:return\s+)?(\{[\s\S]*\})\.to_json\s*$/.exec(s);
    if (json) add({ status: sinatraStatus ? statusCode(sinatraStatus[1]) : null, ...shape(json[1]) });
  }
  if (out.length === 0 && sinatraStatus) add({ status: statusCode(sinatraStatus[1]) });
  return out;
}
