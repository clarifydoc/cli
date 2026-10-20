import type { ParamInfo, RouteResponseInfo } from "../../../types/analysis.js";
import { statusCode } from "../shared/http-status.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * What a Go handler answers, read off its body:
 *
 *   c.JSON(http.StatusCreated, user)                    gin, echo     → 201
 *   c.JSON(200, gin.H{"id": id, "name": n})             gin.H / map literal → keys [id, name]
 *   c.AbortWithStatusJSON(400, gin.H{"error": msg})     → 400, keys [error]
 *   c.Status(201).JSON(order) / c.JSON(order)           fiber         → 201 / default
 *   c.NoContent(204) / c.Status(204) / c.SendStatus(204)
 *   w.WriteHeader(http.StatusCreated); json.NewEncoder(w).Encode(x)   net/http → 201
 *
 * A body that is a struct literal (`&UserDTO{…}`, `UserDTO{…}`) states its
 * type; a variable one only when the function declares it (`var out
 * UserDTO`, `out := UserDTO{…}`). Only a function taking a framework context
 * or a `http.ResponseWriter` is read.
 */

const CTX_TYPES = /^\*?(?:gin\.Context|echo\.Context|fiber\.Ctx|gofr\.Context|iris\.Context|chi\.Context)$/;

/** `gin.H{"a": 1, "b": x}` / `map[string]any{"a": …}` → its keys (sorted); undefined when not a literal. */
function literalKeys(expr: string): string[] | undefined {
  const m = /^(?:gin\.H|fiber\.Map|echo\.Map|map\[string\](?:interface\{\}|any))\s*\{([\s\S]*)\}$/.exec(expr.trim());
  if (!m) return undefined;
  const keys = [...m[1]!.matchAll(/"([^"]+)"\s*:/g)].map((k) => k[1]!);
  return [...new Set(keys)].sort();
}

/** The balanced argument text of the call whose `(` is at `open`. */
function argText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end > i) i = end;
    }
  }
  return text.slice(open + 1);
}

/** Split a call's argument text at its top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (ch === '"') {
      const end = args.indexOf('"', i + 1);
      cur += args.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function extractGoResponses(bodyLines: string[], fn: { name: string; params: ParamInfo[] }): RouteResponseInfo[] {
  const ctx = fn.params.find((p) => CTX_TYPES.test((p.type ?? "").trim()))?.name;
  const writer = fn.params.find((p) => /^http\.ResponseWriter$/.test((p.type ?? "").trim()))?.name;
  if (!ctx && !writer) return [];
  const text = bodyLines.join("\n");
  // Locals a body may be: `var out UserDTO`, `out := UserDTO{…}` / `&UserDTO{…}`.
  const localType = new Map<string, string>();
  for (const m of text.matchAll(/\bvar\s+(\w+)\s+\*?([A-Z]\w*(?:\.[A-Z]\w*)?)\b/g)) localType.set(m[1]!, m[2]!);
  for (const m of text.matchAll(/\b(\w+)\s*:=\s*&?([A-Z]\w*(?:\.[A-Z]\w*)?)\s*\{/g)) localType.set(m[1]!, m[2]!);
  const shape = (expr: string | undefined): Pick<RouteResponseInfo, "type" | "keys"> => {
    if (!expr) return {};
    const keys = literalKeys(expr);
    if (keys) return { keys };
    const lit = /^&?([A-Z]\w*(?:\.[A-Z]\w*)?)\s*\{/.exec(expr.trim()) ?? /^&?\[\]([A-Z]\w*(?:\.[A-Z]\w*)?)\s*\{/.exec(expr.trim());
    if (lit) return { type: expr.trim().includes("[]") ? `[]${lit[1]}` : lit[1]! };
    const t = localType.get(expr.trim().replace(/^&/, ""));
    return t ? { type: t } : {};
  };

  const out: RouteResponseInfo[] = [];
  const seen = new Set<string>();
  const add = (r: RouteResponseInfo) => {
    const key = JSON.stringify(r);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  };
  if (ctx) {
    const c = escapeRegex(ctx);
    for (const m of text.matchAll(new RegExp(String.raw`\b${c}\.(?:Status\(\s*([^)]+)\)\.)?(JSON|IndentedJSON|PureJSON|SecureJSON|AsciiJSON|JSONPretty|AbortWithStatusJSON|XML|NoContent|AbortWithStatus|SendStatus|Status|String)\(`, "g"))) {
      const args = splitArgs(argText(text, m.index! + m[0].length - 1));
      const method = m[2]!;
      if (method === "Status" || method === "NoContent" || method === "AbortWithStatus" || method === "SendStatus") {
        // A bare status, unless it heads a fluent `.Status(201).JSON(x)` (read by the branch above).
        if (text.slice(m.index! + m[0].length - 1).match(/^\([^)]*\)\s*\./)) continue;
        add({ status: statusCode(args[0]) });
        continue;
      }
      if (m[1]) {
        add({ status: statusCode(m[1]), ...shape(args[0]) });
      } else if (args.length >= 2) {
        add({ status: statusCode(args[0]), ...shape(args[1]) });
      } else {
        add({ status: null, ...shape(args[0]) });
      }
    }
  }
  if (writer) {
    const w = escapeRegex(writer);
    const header = new RegExp(String.raw`\b${w}\.WriteHeader\(\s*([^)]+)\)`).exec(text);
    const enc = new RegExp(String.raw`json\.NewEncoder\(\s*${w}\s*\)\.Encode\(`).exec(text);
    if (enc) add({ status: header ? statusCode(header[1]) : null, ...shape(argText(text, enc.index + enc[0].length - 1)) });
    else if (header) add({ status: statusCode(header[1]) });
  }
  return out;
}
