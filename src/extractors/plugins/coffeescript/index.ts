import type { DataSourceInfo, ImportInfo, RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, extractClassesWithSpec, findEndLine, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { dropNestedFunctions } from "../shared/function-postprocess.js";

/**
 * CoffeeScript regex spec (no grammar on npm). Indentation delimits blocks;
 * a function is a value: `name = (args) ->`, a class method `name: (args) ->`,
 * a static `@name: ->`. Calls may omit their parentheses (`save user, force:
 * true`), modules are CommonJS `require` or CoffeeScript 2 `import`. The
 * family is JavaScript's, so a `.coffee` file links into the `.js` around it.
 */

/** Words after which a name is NOT being called with arguments. */
const NOT_ARGUMENT = ["is", "isnt", "and", "or", "in", "of", "then", "instanceof", "not", "unless", "if", "when", "by", "else", "for", "while", "until", "extends", "as", "from"];
/** Words that are no callee. */
const KEYWORDS = [
  "if", "unless", "else", "then", "when", "for", "in", "of", "while", "until", "loop", "do", "return", "new", "class",
  "extends", "try", "catch", "finally", "throw", "switch", "by", "and", "or", "is", "isnt", "not", "yield", "await",
  "typeof", "instanceof", "delete", "break", "continue", "import", "export", "from", "as", "default", "super", "this",
  "true", "false", "yes", "no", "on", "off", "null", "undefined", "function", "own",
];

/**
 * An implicit call — `save user, force: true`, `res.send 201, body`,
 * `describe 'x', ->`, and the nested `log format total` (= `log(format(total))`):
 * any name followed by a space and the start of an argument (never an
 * operator, never a keyword like `is` / `for`).
 */
const IMPLICIT_CALL: CallPattern = {
  pattern: new RegExp(
    String.raw`(?<![\w$.])(?!(?:${KEYWORDS.join("|")})\b)(@?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)` +
      String.raw`[ \t]+(?!(?:${NOT_ARGUMENT.join("|")})\b)(?=[\w"'@\[{$(]|->|=>)`,
  ),
  buildName: (m) => {
    const name = m[1]!.replace(/^@/, "this.");
    return { name, leafName: name.slice(name.lastIndexOf(".") + 1) };
  },
};

/**
 * A parenthesized call — `save(user)`, `@render()` (`this.render`),
 * `path.join(a, b)` — never a keyword before a parenthesis (`a and (b or
 * c)`, `super(x)`, `then (…)`), which the generic `name(` matcher read as
 * calls of `and` / `super` / `then`; so this pattern replaces it.
 */
const PAREN_CALL: CallPattern = {
  pattern: new RegExp(String.raw`(?<![\w$])(?!(?:${KEYWORDS.join("|")})\b)(@?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(`),
  buildName: (m) => {
    const name = m[1]!.replace(/^@/, "this.");
    return { name, leafName: name.slice(name.lastIndexOf(".") + 1) };
  },
  replacesBaseline: true,
};

const FN_VALUE = String.raw`(?:\([^)]*\)\s*)?[-=]>`;

/** `X = require './x'`, `{a, b} = require 'x'`, `import X from './x'`, `import { a } from 'x'`. */
export function coffeeImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  lines.forEach((line, i) => {
    const req = /^\s*(?:(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*)?require\s*\(?\s*['"]([^'"]+)['"]/.exec(line);
    const imp = /^\s*import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]/.exec(line);
    const m = req ?? imp;
    if (!m) return;
    const binding = (m[1] ?? "").trim();
    const specifiers = binding.startsWith("{")
      ? binding.slice(1, -1).split(",").map((s) => s.trim().split(/\s*(?::|\bas\b)\s*/).pop()!).filter(Boolean)
      : binding ? [binding.replace(/^\*\s+as\s+/, "")] : [];
    out.push({ source: m[2]!, specifiers, isDefault: !!binding && !binding.startsWith("{"), isNamespace: false, isType: false, line: i + 1 });
  });
  return out;
}

/** An inline `->` / `=>` (optional params), anywhere on the line. */
const ARROW = new RegExp(String.raw`${FN_VALUE}`);

const ROUTER = /^\s*(app|router|server|api|robot\.router)\.(get|post|put|patch|delete|del|all|use)\s*\(?\s*(['"])([^'"]+)\3(.*)$/;

/**
 * Where an inline Express handler's body starts: on the route line after
 * `->` / `=>` (one-line `-> res.send 'ok'`), or on a continuation line
 * (`app.get '/x',` then indented `(req, res) ->`). `bodyStart`/`bodyEnd` are
 * 0-based exclusive spans of following lines; `inline` is the same-line
 * tail after the arrow (extractCallsFromBody's `inline`).
 */
function coffeeHandlerBody(lines: string[], routeIdx: number): {
  bodyStart: number;
  bodyEnd: number;
  inline?: { line: number; column: number };
  arrowLine: number;
} | null {
  const line = lines[routeIdx]!;
  const onRoute = ARROW.exec(line);
  if (onRoute) {
    const column = onRoute.index + onRoute[0].length;
    return {
      bodyStart: routeIdx + 1,
      bodyEnd: findEndLine(lines, routeIdx, "indent"),
      inline: { line: routeIdx, column },
      arrowLine: routeIdx,
    };
  }
  // Continuation: path ends the route line; the arrow is on the next deeper line.
  if (! /,\s*(?:#.*)?$/.test(line)) return null;
  const routeIndent = /^\s*/.exec(line)![0].length;
  for (let j = routeIdx + 1; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (/^\s*/.exec(lines[j]!)![0].length <= routeIndent) break;
    const arrow = ARROW.exec(lines[j]!);
    if (!arrow) break;
    const column = arrow.index + arrow[0].length;
    return {
      bodyStart: j + 1,
      bodyEnd: findEndLine(lines, j, "indent"),
      inline: { line: j, column },
      arrowLine: j,
    };
  }
  return null;
}

/**
 * Express / Hubot HTTP routes: `app.get '/users', (req, res) ->`,
 * `router.post '/x', auth, create`, `robot.router.get '/hubot/x', …`, a
 * one-line body (`-> res.send 'ok'`), and a continuation-line handler
 * (`app.get '/x',` then indented `(req, res) ->`). A handler named at the
 * end of the line is the handler; one written inline is the route's own.
 * `app.use '/api', apiRouter` is a mount (method null), which the project
 * pass prefixes onto the mounted router's routes.
 */
function coffeeRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  lines.forEach((line, i) => {
    const m = ROUTER.exec(line);
    if (!m) return;
    const verb = m[2]!.toLowerCase();
    const rest = m[5]!;
    const args = rest.split(",").map((a) => a.trim().replace(/\)\s*$/, "")).filter(Boolean);
    const last = args[args.length - 1] ?? "";
    const handler = /^[A-Za-z_$][\w$.]*$/.test(last) ? last : null;
    const middleware = args.slice(0, handler ? -1 : undefined).filter((a) => /^[A-Za-z_$][\w$.]*$/.test(a));
    const body = verb !== "use" ? coffeeHandlerBody(lines, i) : null;
    routes.push({
      path: m[4]!,
      httpMethod: verb === "use" || verb === "all" ? null : verb === "del" ? "DELETE" : verb.toUpperCase(),
      kind: "api",
      handler,
      // An inline handler's body is the route's own: what it calls runs when the route is hit.
      calls: body
        ? extractCallsFromBody(lines, body.bodyStart, body.bodyEnd, coffeeSpec.lineCommentPrefixes, coffeeSpec.callPatterns, body.inline)
        : [],
      middleware,
      line: i + 1,
      ...(verb === "use" ? { mount: true as const } : {}),
    });
  });
  return routes;
}

/**
 * 1-based-as-index spans of the bodies of inline route handlers for
 * `<setup>`: they run when the route is hit, not when the file loads — a
 * route registered inside `module.exports = (app) ->` or `db.connect ->` is
 * still the route's own code — so the route carries their calls and
 * `<setup>` leaves them out. Same-line tails after `->` are blanked by
 * {@link coffeeCallSourceLines} instead.
 */
function coffeeRouteBlocks(lines: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ROUTER.exec(lines[i]!);
    if (!m || m[2] === "use") continue;
    const body = coffeeHandlerBody(lines, i);
    if (body) spans.push([body.bodyStart, body.bodyEnd]);
  }
  return spans;
}

/**
 * Blank every inline route-handler body before function / `<setup>` call
 * scans: the route carries those calls, and a named function that registers
 * the route must not count them again. The text before `->` on the arrow
 * line stays (the `app.get` that runs now).
 */
function coffeeCallSourceLines(lines: readonly string[]): string[] {
  const out = lines.map((l) => l);
  for (let i = 0; i < lines.length; i++) {
    const m = ROUTER.exec(lines[i]!);
    if (!m || m[2] === "use") continue;
    const body = coffeeHandlerBody(lines as string[], i);
    if (!body) continue;
    for (let j = body.bodyStart; j < Math.min(body.bodyEnd, out.length); j++) out[j] = "";
    if (body.inline) {
      const row = out[body.inline.line] ?? "";
      out[body.inline.line] = row.slice(0, body.inline.column) + row.slice(body.inline.column).replace(/[^\n]/g, " ");
    }
  }
  return out;
}

const AJAX = /(?:\$|jQuery)\.(ajax|get|post|getJSON)\b\s*\(?\s*(?:['"]([^'"]+)['"]|url\s*:\s*['"]([^'"]+)['"])?(.*)$/;
const CLIENT = /\b(?:axios|\$http|http|request|superagent)\.(get|post|put|patch|delete)\s*\(?\s*['"]([^'"]+)['"]/;
const FETCH = /\bfetch\s*\(?\s*['"]([^'"]+)['"](.*)$/;
const BACKBONE = /^\s*(url|urlRoot)\s*:\s*['"]([^'"]+)['"]/;

/**
 * API calls a CoffeeScript frontend makes: jQuery (`$.ajax url: '/x', type:
 * 'POST'`, also with the options on the lines below; `$.post '/x'`), axios /
 * Angular `$http` / superagent, `fetch`, and Backbone — a model's `urlRoot`
 * / a collection's `url` (a class member, in a file that uses Backbone) is
 * where its `fetch` / `save` go.
 */
function coffeeDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const consumed = new Set<number>();
  const push = (method: string, raw: string, line: number, column: number) => {
    // `"/api/orders/#{@id}/close"` → `/api/orders/{id}/close`
    const target = raw.replace(/#\{\s*@?([\w.]+?)\s*\}/g, (_m, v: string) => `{${v.split(".").pop()}}`);
    if (!target.startsWith("/") && !/^https?:\/\//.test(target)) return;
    out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line, column });
  };
  const usesBackbone = lines.some((l) => /\bBackbone\./.test(l));
  lines.forEach((line, i) => {
    if (consumed.has(i)) return;
    let m = AJAX.exec(line);
    if (m) {
      const fn = m[1]!;
      let options = m[4] ?? "";
      let url: string | undefined = m[2] ?? m[3];
      // `$.ajax` / options object on the following, deeper-indented lines.
      const indent = /^\s*/.exec(line)![0].length;
      for (let j = i + 1; j < lines.length && (lines[j]!.trim() === "" || /^\s*/.exec(lines[j]!)![0].length > indent); j++) {
        options += " " + lines[j];
        consumed.add(j);
        url ??= /\burl\s*:\s*['"]([^'"]+)['"]/.exec(lines[j]!)?.[1];
      }
      const type = /\b(?:type|method)\s*:\s*['"](\w+)['"]/i.exec(options)?.[1];
      if (url) push((type ?? (fn === "post" ? "POST" : "GET")).toUpperCase(), url, i + 1, m.index);
      return;
    }
    if ((m = CLIENT.exec(line))) { push(m[1]!.toUpperCase(), m[2]!, i + 1, m.index); return; }
    if ((m = FETCH.exec(line))) { push((/method\s*:\s*['"](\w+)['"]/i.exec(m[2] ?? "")?.[1] ?? "GET").toUpperCase(), m[1]!, i + 1, m.index); return; }
    if (usesBackbone && (m = BACKBONE.exec(line))) push("GET", m[2]!, i + 1, m.index);
  });
  return out;
}

/**
 * The file in the C-like shape the shared SQL scanner reads (`db.query
 * 'SELECT …'`): each `'…'` / `"…"` string — and each line of a `"""` / `'''`
 * block — a `"…"` literal, `#` comments dropped, a `;` ending each line that
 * ends a statement. One output line per input line.
 */
function coffeeSqlLines(lines: string[]): string[] {
  const out: string[] = [];
  let block: string | null = null;
  const lit = (t: string) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  for (const line of lines) {
    if (block) {
      const close = line.indexOf(block);
      if (close < 0) { out.push(lit(line)); continue; }
      out.push(lit(line.slice(0, close)) + ";");
      block = null;
      continue;
    }
    let code = "";
    let quote: string | null = null;
    let text = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === "\\") { text += line[i + 1] ?? ""; i++; continue; }
        if (c === quote) { code += lit(text); text = ""; quote = null; continue; }
        text += c;
        continue;
      }
      const three = line.slice(i, i + 3);
      if (three === '"""' || three === "\'\'\'") {
        const close = line.indexOf(three, i + 3);
        if (close < 0) { code += lit(line.slice(i + 3)); block = three; i = line.length; break; }
        code += lit(line.slice(i + 3, close));
        i = close + 2;
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") { quote = c; continue; }
      code += c;
    }
    if (quote) code += lit(text);
    out.push(block || /[,(\[{+]\s*$/.test(code) ? code : code + ";");
  }
  return out;
}

/** 1-based [start, end] of every function value declared in the file (any depth). */
const SPANS = new WeakMap<string[], Array<[number, number]>>();
function functionSpans(lines: string[]): Array<[number, number]> {
  let spans = SPANS.get(lines);
  if (!spans) {
    spans = [];
    for (let i = 0; i < lines.length; i++) {
      if (coffeeSpec.functionPatterns.some((p) => p.pattern.test(lines[i]!))) spans.push([i + 1, findEndLine(lines, i, "indent")]);
    }
    SPANS.set(lines, spans);
  }
  return spans;
}

/**
 * What is not code, blanked before extraction (line structure kept): `###`
 * block comments, and the INSIDE of every `"""` / `'''` heredoc and `///`
 * heregex — prose there ("Unable to find the file") would otherwise read as
 * implicit calls. Their SQL is read from the raw source (`coffeeSqlSources`).
 */
export function blankNonCode(source: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return blankMultilineStrings(
    source
      .replace(/^([ \t]*)###(?!#)[\s\S]*?###/gm, blank)
      .replace(/("""|\'\'\'|\/\/\/)([\s\S]*?)\1/g, (_m, q: string, body: string) => q + blank(body) + q),
  );
}

/**
 * A `"…"` / `'…'` string may run over several lines in CoffeeScript; the
 * line-based extraction would read its later lines as code ("…see the
 * watery part…" → calls of `see`, `the`). Blank the text of every string
 * that spans lines — keeping its quotes, its `#{…}` interpolations (code) and
 * every line break. One-line strings stay: routes and URLs are read from them.
 * Comments and regex literals are skipped so a quote inside one opens nothing.
 */
function blankMultilineStrings(src: string): string {
  let out = "";
  let i = 0;
  let lastCode = "";
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (three === '"""' || three === "\'\'\'" || three === "///") {
      const close = src.indexOf(three, i + 3);
      const end = close < 0 ? src.length : close + 3;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && /^$|[(,=:[!&|?{};]$/.test(lastCode)) {
      // A regex literal: `/don't/` — up to the closing `/` on the same line.
      const m = /^\/(?![\s/])(?:\\.|[^/\n\\])+\/[gimsuy]*/.exec(src.slice(i));
      if (m) { out += m[0]; i += m[0].length; lastCode = "/"; continue; }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let depth = 0;
      let body = c;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\\") { body += src.slice(j, j + 2); j += 2; continue; }
        if (c === '"' && d === "#" && src[j + 1] === "{") { depth++; body += "#{"; j += 2; continue; }
        if (depth > 0) {
          if (d === "{") depth++;
          else if (d === "}") depth--;
          body += d;
          j++;
          continue;
        }
        body += d;
        j++;
        if (d === c) break;
      }
      if (body.includes("\n")) {
        // Blank the text, keep quotes, line breaks and interpolated code.
        let kept = "";
        let level = 0;
        for (let k = 0; k < body.length; k++) {
          const ch = body[k]!;
          if (k === 0 || k === body.length - 1 || ch === "\n") { kept += ch; continue; }
          if (ch === "#" && body[k + 1] === "{") { level++; kept += "#{"; k++; continue; }
          if (level > 0) { if (ch === "{") level++; else if (ch === "}") level--; kept += ch; continue; }
          kept += " ";
        }
        body = kept;
      }
      out += body;
      i = j;
      lastCode = c;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastCode = c;
    else if (c === "\n") lastCode = "";
    i++;
  }
  return out;
}

/** SQL statements in the file's strings, heredocs included (raw source). */
export function coffeeSqlSources(rawLines: string[]): DataSourceInfo[] {
  return extractSqlStringDataSources(coffeeSqlLines(rawLines));
}

/**
 * Literate CoffeeScript (`.litcoffee`) is Markdown whose code is the indented
 * (4 spaces / a tab) blocks: every prose line is blanked, keeping the line
 * count, so a sentence never reads as an implicit call.
 */
export function literateCode(source: string): string {
  return source
    .split("\n")
    .map((line) => (/^(?: {4}|\t)/.test(line) ? line.replace(/^(?: {4}|\t)/, "") : ""))
    .join("\n");
}

export const coffeeSpec: RegexLangSpec = {
  language: "coffeescript",
  extensions: [".coffee", ".litcoffee"],
  indentBased: true,
  lineCommentPrefixes: ["#"],
  topLevelCalls: true,
  deferredBlocks: coffeeRouteBlocks,
  // Handler bodies belong to the route, not the function / `<setup>` that registers them.
  callSourceLines: coffeeCallSourceLines,
  functionPatterns: [
    // `name = (args) ->` / `export name = ->` / `@name = =>`
    { pattern: new RegExp(String.raw`^\s*(?:export\s+)?@?([A-Za-z_$][\w$]*)\s*=\s*${FN_VALUE}`), isExported: () => true },
    // class members `name: (args) ->` / `@name: ->`
    { pattern: new RegExp(String.raw`^\s+@?([A-Za-z_$][\w$]*)\s*:\s*${FN_VALUE}`), isExported: () => true },
  ],
  classPatterns: [
    {
      pattern: /^\s*(?:export\s+)?class\s+@?([A-Z][\w$]*)/,
      getExtends: (line) => /\bextends\s+([\w$.]+)/.exec(line)?.[1]?.split(".").pop() ?? null,
    },
  ],
  importPatterns: [],
  callPatterns: [IMPLICIT_CALL, PAREN_CALL],
  // Overriding class extraction also makes core drop methods from the
  // top-level function list.
  extractClasses: (lines) => {
    const classes = extractClassesWithSpec(lines, coffeeSpec);
    for (const cls of classes) cls.methods = dropNestedFunctions(cls.methods, functionSpans(lines));
    return classes;
  },
  postProcessFunctions: (lines, fns) => dropNestedFunctions(fns, functionSpans(lines)),
  extractRoutes: (lines) => coffeeRoutes(lines),
  extractDataSources: (lines) => coffeeDataSources(lines),
};
