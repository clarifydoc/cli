import type { ClassInfo, PropertyInfo, RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, pathParamNames } from "../../shared/route-metadata.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * JSight API-description files (https://jsight.io) — a line-oriented spec
 * format used by contract-first services. Each endpoint opens with an
 * unindented `VERB /path` line:
 *
 *   GET /find-persons
 *     Query "search=xxx"
 *     200
 *       @PersonDataResponse
 *
 * Contract-first backends often implement interfaces from an external API
 * artifact, so their resource classes carry NO routing annotations — the spec
 * file is the only in-repo statement of the served API surface. Each endpoint
 * line becomes one `api` route.
 *
 * The indented block below an endpoint is its attribute layer, declared by
 * the contract (nothing `inferred`): `Path { "id": 1 }` types the `{id}`
 * tokens of the path (route params), `Query "a=1&b=2"` / `Query { … }` /
 * `Query @T` → query params, `Request @T` / `Request { … }` / `Request` +
 * `Body …` → one body param, `Headers { … }` → header params. Blocks under a
 * response status are the response, not the request, and are skipped.
 * `TYPE @Name` blocks become classes whose properties carry the JSON type
 * inferred from the example value or the `// {type: "…"}` annotation
 * (`{optional: true}` clears `isRequired`), which `request-schema.ts` reads
 * back for a body schema.
 */

const HTTP_VERBS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
const ENDPOINT_RE = new RegExp(`^(${HTTP_VERBS})\\s+(\\/\\S*)\\s*$`);
const URL_RE = /^URL\s+(\/\S*)\s*$/;
const NESTED_VERB_RE = new RegExp(`^\\s+(${HTTP_VERBS})\\s*$`);
const TYPE_RE = /^TYPE\s+@([A-Za-z_]\w*)\s*(.*)$/;
const DIRECTIVE_RE = /^(\s*)(Path|Query|Request|Headers|Body|Description|\d{3})\b\s*(.*)$/;

function indentOf(line: string): number {
  return (line.match(/^\s*/)?.[0].length) ?? 0;
}

/** The indented block below line `i`: everything until the next unindented non-blank line. */
function blockAfter(lines: string[], i: number): string[] {
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (line.trim() !== "" && indentOf(line) === 0) break;
    out.push(line);
  }
  return out;
}

// ─── JSON-ish value reading ────────────────────────────────────────────────────

/** Split a line into its code and the `// …` comment, honouring strings. */
function splitComment(line: string): { code: string; comment: string } {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"' && line[i - 1] !== "\\") quote = !quote;
    else if (!quote && ch === "/" && line[i + 1] === "/") {
      return { code: line.slice(0, i), comment: line.slice(i + 2) };
    }
  }
  return { code: line, comment: "" };
}

/** Bracket delta of a code fragment, ignoring brackets inside strings. */
function depthDelta(code: string): number {
  let d = 0;
  let quote = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' && code[i - 1] !== "\\") quote = !quote;
    else if (!quote && (ch === "{" || ch === "[")) d++;
    else if (!quote && (ch === "}" || ch === "]")) d--;
  }
  return d;
}

/** JSight annotation types → the type text `request-schema.ts` reads back. */
const ANNOTATION_TYPES: Record<string, string> = {
  string: "string", integer: "integer", float: "number", boolean: "boolean",
  date: "string(date)", datetime: "string(date-time)", uuid: "string(uuid)", email: "string(email)",
  uri: "string(uri)", enum: "string", any: "any", null: "any", mixed: "any", object: "object",
};

/** The type of a JSON-ish scalar/opening token (`"x"`, `42`, `1.5`, `true`, `@Ref`, `{`, `[`). */
function tokenType(token: string): string | null {
  const t = token.trim();
  if (t === "") return null;
  if (t.startsWith("@")) return t.slice(1).match(/^[A-Za-z_]\w*/)?.[0] ?? null;
  if (t.startsWith('"')) return "string";
  if (t.startsWith("{")) return "object";
  if (t.startsWith("[")) return null; // arrays are resolved by the caller (element type)
  const head = t.replace(/[\s,}\]]+$/, "");
  if (/^-?\d+$/.test(head)) return "integer";
  if (/^-?\d*\.\d+(?:e[+-]?\d+)?$/i.test(head)) return "number";
  if (/^(true|false)\b/.test(head)) return "boolean";
  if (/^null\b/.test(head)) return "any";
  return null;
}

/** `{type: "uuid", optional: true}` → { type, optional }. */
function parseAnnotation(comment: string): { type: string | null; optional: boolean } {
  const m = /\{(.*)\}/s.exec(comment);
  if (!m) return { type: null, optional: false };
  const body = m[1]!;
  const typeM = /\btype\s*:\s*"?(@?[A-Za-z_][\w.]*)"?/.exec(body);
  const optional = /\boptional\s*:\s*true\b/.test(body);
  let type: string | null = null;
  if (typeM) {
    const raw = typeM[1]!;
    type = raw.startsWith("@") ? raw.slice(1) : (ANNOTATION_TYPES[raw] ?? null);
    if (raw === "array") type = "any[]";
  }
  return { type, optional };
}

export interface JsightProp {
  name: string;
  type: string | null;
  optional: boolean;
}

/**
 * The top-level keys of a JSON-ish object spread over `lines` (the first
 * non-blank line opens it with `{`), each typed from its example value or
 * annotation. Nested objects/arrays are skipped by depth.
 */
export function parseJsightObject(input: string[]): JsightProp[] {
  // A one-line object (`{ "page": 1 }`) keeps its keys on the opening line:
  // split the brace off so the depth-1 scan below sees them.
  const lines = input.flatMap((l) => {
    const m = /^(\s*\{)\s*(\S.*)$/.exec(l);
    return m ? [m[1]!, m[2]!] : [l];
  });
  const out: JsightProp[] = [];
  let depth = 0;
  let pendingArray: JsightProp | null = null; // an array opened on its own line, awaiting its first element
  for (let i = 0; i < lines.length; i++) {
    const { code, comment } = splitComment(lines[i]!);
    const trimmed = code.trim();
    if (pendingArray && trimmed !== "" && depth === 2) {
      const el = tokenType(trimmed);
      pendingArray.type = `${el ?? "any"}[]`;
      pendingArray = null;
    }
    if (depth === 1) {
      const m = /^\s*"([^"]+)"\s*:\s*(.*)$/.exec(code);
      if (m) {
        const value = m[2]!.trim().replace(/,\s*$/, "");
        const ann = parseAnnotation(comment);
        let type = ann.type;
        if (!type) {
          if (value.startsWith("[")) {
            const inner = value.slice(1).trim();
            if (inner === "" || inner === "]") type = inner === "]" ? "any[]" : null;
            else type = `${tokenType(inner) ?? "any"}[]`;
          } else {
            type = tokenType(value);
          }
        }
        const prop: JsightProp = { name: m[1]!, type, optional: ann.optional };
        out.push(prop);
        if (value.startsWith("[") && type === null) pendingArray = prop;
      }
    }
    depth += depthDelta(code);
    if (depth <= 0 && trimmed !== "" && out.length > 0) break;
  }
  if (pendingArray) pendingArray.type = "any[]";
  return out;
}

// ─── Directive content ─────────────────────────────────────────────────────────

interface DirectiveBody {
  /** The directive's inline remainder plus its indented continuation lines. */
  lines: string[];
}

/** Directives of an endpoint block at any indent, with their bodies; response blocks skipped. */
function directivesOf(block: string[]): Array<{ name: string; body: DirectiveBody }> {
  const out: Array<{ name: string; body: DirectiveBody }> = [];
  for (let i = 0; i < block.length; i++) {
    const m = DIRECTIVE_RE.exec(block[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const body: string[] = [];
    if (m[3]!.trim()) body.push(m[3]!);
    let j = i + 1;
    for (; j < block.length; j++) {
      const line = block[j]!;
      if (line.trim() !== "" && indentOf(line) <= indent) break;
      body.push(line);
    }
    // A status code opens the response: nothing under it is request detail.
    if (/^\d{3}$/.test(m[2]!)) { i = j - 1; continue; }
    out.push({ name: m[2]!, body: { lines: body } });
    // A directive owns its body: `Request` re-scans its own lines for the
    // nested `Headers` / `Body`, so the outer scan must not see them again.
    i = j - 1;
  }
  return out;
}

/** First meaningful token of a directive body: `@Type`, `{`, `"…"` or `[`. */
function contentOf(body: DirectiveBody): { kind: "ref" | "object" | "string" | "array" | "none"; text: string; lines: string[] } {
  const idx = body.lines.findIndex((l) => splitComment(l).code.trim() !== "");
  if (idx < 0) return { kind: "none", text: "", lines: [] };
  const lines = body.lines.slice(idx);
  const text = splitComment(lines[0]!).code.trim();
  if (text.startsWith("@")) return { kind: "ref", text: text.slice(1).match(/^[A-Za-z_]\w*/)?.[0] ?? "", lines };
  if (text.startsWith("{")) return { kind: "object", text, lines };
  if (text.startsWith("[")) return { kind: "array", text, lines };
  if (text.startsWith('"')) return { kind: "string", text: text.replace(/^"|"$/g, ""), lines };
  return { kind: "none", text, lines };
}

function objectParams(lines: string[], binding: RouteParamInfo["binding"]): RouteParamInfo[] {
  return parseJsightObject(lines).map((p) => ({ name: p.name, type: p.type, binding }));
}

/** The request half of an endpoint block as route params. */
function paramsOf(path: string, block: string[]): RouteParamInfo[] {
  const route = new Map<string, RouteParamInfo>();
  for (const name of pathParamNames(path)) route.set(name, { name, type: null, binding: "route" });
  // Keep the token's spelling from the path rather than the lower-cased key.
  for (const m of path.matchAll(/\{([A-Za-z_]\w*)\}/g)) route.set(m[1]!.toLowerCase(), { name: m[1]!, type: null, binding: "route" });
  const query: RouteParamInfo[] = [];
  const headers: RouteParamInfo[] = [];
  let body: RouteParamInfo | null = null;

  const bodyParam = (content: ReturnType<typeof contentOf>): RouteParamInfo | null => {
    switch (content.kind) {
      case "ref": return { name: "body", type: content.text, binding: "body" };
      case "object": return { name: "body", type: "object", binding: "body" };
      case "array": {
        const inner = content.text.slice(1).trim();
        const el = inner && inner !== "]" ? tokenType(inner) : null;
        return { name: "body", type: `${el ?? "any"}[]`, binding: "body" };
      }
      default: return null;
    }
  };

  for (const d of directivesOf(block)) {
    const content = contentOf(d.body);
    switch (d.name) {
      case "Path": {
        if (content.kind === "object") {
          for (const p of parseJsightObject(content.lines)) {
            const key = p.name.toLowerCase();
            route.set(key, { name: route.get(key)?.name ?? p.name, type: p.type, binding: "route" });
          }
        }
        break;
      }
      case "Query": {
        if (content.kind === "string") {
          for (const pair of content.text.split("&")) {
            const name = pair.split("=")[0]!.trim();
            if (name && !query.some((q) => q.name === name)) query.push({ name, type: null, binding: "query" });
          }
        } else if (content.kind === "object") {
          query.push(...objectParams(content.lines, "query"));
        } else if (content.kind === "ref") {
          query.push({ name: "query", type: content.text, binding: "query" });
        }
        break;
      }
      case "Headers": {
        if (content.kind === "object") headers.push(...objectParams(content.lines, "header"));
        break;
      }
      case "Request": {
        const nested = directivesOf(d.body.lines);
        const bodyDirective = nested.find((n) => n.name === "Body");
        for (const h of nested.filter((n) => n.name === "Headers")) {
          const c = contentOf(h.body);
          if (c.kind === "object") headers.push(...objectParams(c.lines, "header"));
        }
        body = bodyParam(bodyDirective ? contentOf(bodyDirective.body) : content) ?? body;
        break;
      }
      case "Body": {
        // A bare `Body` at endpoint level (outside `Request`) is the request body too.
        body = bodyParam(content) ?? body;
        break;
      }
    }
  }
  return [...route.values(), ...query, ...headers, ...(body ? [body] : [])];
}

// ─── Routes ────────────────────────────────────────────────────────────────────

export function extractJsightRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const push = (method: string, path: string, line: number, block: string[]) => {
    const route: RouteInfo = {
      path,
      httpMethod: method,
      kind: "api",
      handler: null,
      calls: [],
      middleware: [],
      line,
    };
    applyRouteMeta(route, { params: paramsOf(path, block) });
    routes.push(route);
  };
  for (let i = 0; i < lines.length; i++) {
    const m = ENDPOINT_RE.exec(lines[i]!);
    if (m) {
      push(m[1]!, m[2]!, i + 1, blockAfter(lines, i));
      continue;
    }
    // `URL /path` groups several verbs, each an indented `VERB` line with its own block.
    const u = URL_RE.exec(lines[i]!);
    if (!u) continue;
    const block = blockAfter(lines, i);
    for (let j = 0; j < block.length; j++) {
      const v = NESTED_VERB_RE.exec(block[j]!);
      if (!v) continue;
      const indent = indentOf(block[j]!);
      const sub: string[] = [];
      for (let k = j + 1; k < block.length; k++) {
        if (block[k]!.trim() !== "" && indentOf(block[k]!) <= indent) break;
        sub.push(block[k]!);
      }
      push(v[1]!, u[1]!, i + 1 + j + 1, sub);
    }
  }
  return routes;
}

// ─── TYPE blocks → classes ─────────────────────────────────────────────────────

export function extractJsightTypes(lines: string[]): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TYPE_RE.exec(lines[i]!);
    if (!m) continue;
    const block = blockAfter(lines, i);
    const content = contentOf({ lines: [m[2]!, ...block] });
    const properties: PropertyInfo[] = [];
    let base: string | null = null;
    if (content.kind === "object") {
      for (const p of parseJsightObject(content.lines)) {
        const prop: PropertyInfo = { name: p.name, type: p.type, visibility: "public", isStatic: false, isReadonly: false };
        if (!p.optional) prop.isRequired = true;
        properties.push(prop);
      }
    } else if (content.kind === "ref") {
      // `TYPE @Admin @User` / `TYPE @Admin` + `@User`: an alias, flattened via `extends`.
      base = content.text || null;
    }
    out.push({
      name: m[1]!,
      extends: base,
      implements: [],
      decorators: ["jsight"],
      methods: [],
      properties,
      isExported: true,
      line: i + 1,
      endLine: i + 1 + block.length,
    });
  }
  return out;
}

export const jsightSpec: RegexLangSpec = {
  language: "jsight",
  extensions: [".jsight"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["//"],
  extractRoutes: (lines) => extractJsightRoutes(lines),
  extractClasses: (lines) => extractJsightTypes(lines),
};
