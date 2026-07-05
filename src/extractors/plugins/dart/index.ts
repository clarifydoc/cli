import type {
  RouteInfo,
  ClassInfo,
  FunctionInfo,
  DataSourceInfo,
  ParamInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

/**
 * Dart (and therefore Flutter) regex extraction.
 *
 * Dart has no `func`/`def`/`fn` keyword, so — like C/C++ — a declaration is
 * recognised structurally: an optional leading return type / modifiers, a name,
 * a parameter list, and a body opener (`{`, `=>`, or an `async`/`sync` marker).
 * Unlike C, Flutter code is saturated with trailing-closure calls
 * (`setState(() {`, `Future.delayed(d, () {`), so the brace-terminated form
 * alone over-matches. We additionally REQUIRE a return-type / modifier token in
 * front of the name; call sites like `setState(() {` have no such prefix
 * (`setState` is the first token and is followed immediately by `(`), so they
 * are rejected. The cost is that constructors and return-typeless methods
 * (`build() {`) are not captured — an accepted trade-off for the regex path.
 */

/** Reserved words that can begin a statement and must never be read as a declaration. */
const STMT_KEYWORDS =
  "if|for|while|switch|catch|do|else|return|case|await|yield|assert|throw|rethrow|break|continue|new|super|this|in|is|as|set|get|var|final|const|late|covariant|typedef|library|part|import|export";

/**
 * A return type / modifier token immediately preceding the method name. Allows
 * a single generic clause (`Future<User>`, `List<Map<String, int>>`) and a
 * trailing `?` (nullable). Greedy `[^;{(]*` inside the generic swallows nested
 * `<…>` up to the last `>` before the name's `(`.
 */
const TYPE_TOKEN = String.raw`[A-Za-z_$][\w$]*(?:\s*<[^;{(]*>)?\??`;

/**
 * Function / method definition: `<modifiers>* <ReturnType> name(<params>) [async|sync*] (=> | {)`.
 * The return type is required (see file header); the body opener (`=>` or `{`)
 * excludes both prototypes/abstract signatures and `;`-terminated call statements.
 */
const DART_FUNCTION = new RegExp(
  String.raw`^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*` + // annotations
    String.raw`(?!(?:${STMT_KEYWORDS})\b)` + // not a statement keyword
    String.raw`(?:(?:external|static|abstract|factory)\s+)*` + // leading modifiers
    String.raw`(?:${TYPE_TOKEN}\s+)` + // REQUIRED return type
    String.raw`([A-Za-z_$]\w*)` + // (1) method name
    String.raw`\s*(?:<[^;{(]*>)?\s*` + // optional method type params
    String.raw`\([^)]*\)` + // parameter list (first `)` wins)
    String.raw`\s*(?:async\*?|sync\*?)?\s*(?:=>|\{)`, // async marker + body opener
);

/** Pull the declared return type from a definition line (null for `void`). */
function parseDartReturnType(line: string): string | null {
  const m = line.match(
    new RegExp(
      String.raw`^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*` +
        String.raw`(?:(?:external|static|abstract|factory)\s+)*` +
        String.raw`(${TYPE_TOKEN})\s+[A-Za-z_$]\w*\s*(?:<[^;{(]*>)?\s*\(`,
    ),
  );
  if (!m) return null;
  const t = m[1]!.trim();
  return !t || t === "void" || t === "Future" || t === "void?" ? null : t;
}

/** Parse a Dart parameter token: `int id`, `String? name`, `this.client`, `{Key? key}`, `required User u`. */
function parseDartParam(paramText: string): ParamInfo | null {
  let trimmed = paramText.trim().replace(/^[{[]|[}\]]$/g, "").trim();
  if (!trimmed) return null;
  // Default value: `name = expr` / `name: expr` (named).
  let defaultValue: string | null = null;
  const eq = trimmed.match(/[:=]\s*(.+)$/);
  if (eq && !/<.*>/.test(trimmed.slice(0, trimmed.indexOf(eq[0])))) {
    defaultValue = eq[1]!.trim();
    trimmed = trimmed.slice(0, trimmed.indexOf(eq[0])).trim();
  }
  trimmed = trimmed.replace(/^(?:required|covariant|final|const)\s+/, "");
  // `this.client` / `super.key` — field-initialising formal.
  const thisM = trimmed.match(/^(?:this|super)\.([A-Za-z_$]\w*)$/);
  if (thisM) return { name: thisM[1]!, type: null, defaultValue };
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    // Bare token — a name with no type (e.g. closure params `(value)`).
    return { name: tokens[0]!.replace(/[?,]/g, ""), type: null, defaultValue };
  }
  const name = tokens[tokens.length - 1]!.replace(/[?,]/g, "");
  const type = tokens.slice(0, -1).join(" ").replace(/[?]$/, "");
  return { name, type, defaultValue };
}

// ─── Imports ──────────────────────────────────────────────────────────────

/** Split a `show`/`hide`/`as` tail into its specifier identifiers. */
function importSpecifiers(tail: string): string[] {
  const specs: string[] = [];
  const asM = tail.match(/\bas\s+([A-Za-z_$]\w*)/);
  if (asM) specs.push(asM[1]!);
  for (const c of tail.matchAll(/\b(?:show|hide)\s+([A-Za-z_$][\w$,\s]*)/g)) {
    for (const id of c[1]!.split(",")) {
      const t = id.trim().split(/\s+/)[0];
      if (t) specs.push(t);
    }
  }
  return specs;
}

// ─── Data sources (the screen → API → DB half) ──────────────────────────────

const HTTP_VERBS =
  "get|post|put|patch|delete|head|read|request|getUri|postUri|putUri|patchUri|deleteUri|download|send";

/** A receiver name that looks like an HTTP client (`http`, `dio`, `_client`, `apiClient`, `Dio()`). */
const HTTP_RECEIVER_RE = /(?:^|_)(?:http|dio|client|api)/i;

/** `<recv>.<verb>(` — global so a line can hold several. */
const HTTP_CALL_RE = new RegExp(
  String.raw`(?<![\w.])((?:[A-Za-z_$]\w*)|Dio\(\))\.(${HTTP_VERBS})\s*\(`,
  "g",
);

/** `.collection('users')` (Cloud Firestore) → collection name. */
const FIRESTORE_RE = /\.collection\(\s*['"]([^'"]+)['"]\s*\)/g;

/** `supabase….from('table')` (Supabase). */
const SUPABASE_RE = /\bsupabase\w*\.from\(\s*['"]([^'"]+)['"]\s*\)/gi;

/** sqflite `db.query('users', …)` and friends; the first string arg is the table. */
const SQFLITE_RE = new RegExp(
  String.raw`\b(?:_?db|_?database|txn|batch)\.(query|insert|update|delete|rawQuery|rawInsert|rawUpdate|rawDelete|execute)\s*\(\s*(?:['"]([^'"]+)['"])?`,
  "g",
);

/** Methods whose first string arg names a table (vs raw SQL we can't attribute). */
const SQFLITE_TABLE_METHODS = new Set(["query", "insert", "update", "delete"]);

/** Pull a URL-ish first argument out of an HTTP call (`'…'`, `"…"`, or `Uri.parse('…')`). */
function firstUrlArg(line: string, fromIndex: number): string | null {
  const slice = line.slice(fromIndex);
  const uri = slice.match(/^\s*Uri\.(?:parse|https?)\(\s*['"]([^'"]+)['"]/);
  if (uri) return uri[1]!;
  const str = slice.match(/^\s*['"]([^'"]+)['"]/);
  return str ? str[1]! : null;
}

function extractDartDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const seen = new Set<string>();
  const push = (d: DataSourceInfo) => {
    const key = `${d.kind}:${d.name}@${d.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const ln = i + 1;

    // HTTP clients — http / dio / generic clients.
    for (const m of line.matchAll(HTTP_CALL_RE)) {
      const receiver = m[1]!;
      const verb = m[2]!;
      if (!HTTP_RECEIVER_RE.test(receiver)) continue;
      push({
        kind: "api-call",
        name: `${receiver}.${verb}`,
        target: firstUrlArg(line, m.index! + m[0]!.length),
        calls: [],
        line: ln,
      });
    }

    // Cloud Firestore — `.collection('x')`.
    for (const m of line.matchAll(FIRESTORE_RE)) {
      push({ kind: "database", name: `collection(${m[1]})`, target: m[1]!, calls: [], line: ln, entity: m[1]! });
    }

    // Supabase — `supabase.from('table')`.
    for (const m of line.matchAll(SUPABASE_RE)) {
      push({ kind: "database", name: `from(${m[1]})`, target: m[1]!, calls: [], line: ln, entity: m[1]! });
    }

    // sqflite — `db.query('users', …)`.
    for (const m of line.matchAll(SQFLITE_RE)) {
      const method = m[1]!;
      const table = SQFLITE_TABLE_METHODS.has(method) ? m[2] ?? null : null;
      push({
        kind: "database",
        name: `db.${method}`,
        target: table,
        calls: [],
        line: ln,
        ...(table ? { entity: table } : {}),
      });
    }
  }
  return out;
}

// ─── Routes ──────────────────────────────────────────────────────────────

/** shelf_router receiver — `router`, `_router`, `app`, `server`, `mux`, `r`. */
const ROUTER_RECEIVER_RE = /^(?:_?router|_?app|server|_?mux|r)$/;

/** `router.get('/path', handler)` / `app..post('/x', h)` (shelf_router, dart_frog). */
const SHELF_ROUTE_RE =
  /\b([A-Za-z_$]\w*)\s*(?:\.\.|\.)\s*(get|post|put|patch|delete|head|options|all|mount)\s*\(\s*['"](\/[^'"]*)['"]\s*(?:,\s*([A-Za-z_$][\w$.]*))?/g;

/** GoRouter `GoRoute(path: '/users/:id', builder: (c, s) => UsersPage())`. */
const GOROUTE_RE = /GoRoute\(\s*path:\s*['"]([^'"]+)['"]/;

function extractDartRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const ln = i + 1;

    // Server-side API routes (shelf_router / dart_frog).
    for (const m of line.matchAll(SHELF_ROUTE_RE)) {
      const receiver = m[1]!;
      if (!ROUTER_RECEIVER_RE.test(receiver)) continue;
      const verb = m[2]!;
      if (verb === "mount") continue; // sub-router mount, not an endpoint
      routes.push({
        path: m[3]!,
        httpMethod: verb.toUpperCase(),
        kind: "api",
        handler: m[4] ?? null,
        calls: [],
        middleware: [],
        line: ln,
      });
    }

    // GoRouter declarative routes → frontend screens.
    const go = line.match(GOROUTE_RE);
    if (go) {
      const widget = line.match(/=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/);
      routes.push({
        path: go[1]!,
        httpMethod: null,
        kind: "frontend",
        handler: widget ? widget[1]! : null,
        calls: [],
        middleware: [],
        line: ln,
      });
    }
  }
  return routes;
}

// ─── Classes (with `with`/`implements` edges) ───────────────────────────────

/** Split a comma list of (possibly generic) type names into bare identifiers. */
function splitTypeList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().replace(/<.*$/, "").trim())
    .filter((s) => /^[A-Za-z_$]\w*$/.test(s));
}

/** Join a class declaration that may wrap across lines, up to its body `{`. */
function declarationText(lines: string[], startIdx: number): string {
  let text = "";
  for (let i = startIdx; i < Math.min(startIdx + 5, lines.length); i++) {
    text += " " + (lines[i] ?? "");
    if (lines[i]?.includes("{")) break;
  }
  return text;
}

/**
 * Wrap the generic class extractor to attach mixins (`with M1, M2`) and
 * interfaces (`implements I1, I2`) as `implements` edges — Dart's mixin model
 * maps onto interface-implementation the same way Ruby's does. Providing this
 * also triggers `regex-extractor.ts`'s method de-duplication, so a class method
 * isn't double-listed as a top-level function.
 */
function extractDartClasses(lines: string[]): ClassInfo[] {
  const classes = extractClassesWithSpec(lines, dartSpec);
  for (const cls of classes) {
    const decl = declarationText(lines, cls.line - 1);
    const seen = new Set<string>(cls.implements ?? []);
    const withM = decl.match(/\bwith\s+([^{]*?)(?:\s+implements\b|\s*\{|$)/);
    if (withM) for (const n of splitTypeList(withM[1]!)) seen.add(n);
    const implM = decl.match(/\bimplements\s+([^{]*?)(?:\s*\{|$)/);
    if (implM) for (const n of splitTypeList(implM[1]!)) seen.add(n);
    cls.implements = [...seen];
  }
  return classes;
}

export const dartSpec: RegexLangSpec = {
  language: "dart",
  extensions: [".dart"],
  blockStyle: "brace",
  lineCommentPrefixes: ["//", "///"],

  functionPatterns: [
    {
      pattern: DART_FUNCTION,
      isExported: (_line, name) => !name.startsWith("_"),
      isAsync: (line) => /\basync\b/.test(line),
    },
  ],

  parseParam: parseDartParam,
  parseReturnType: parseDartReturnType,

  classPatterns: [
    {
      pattern:
        /^\s*(?:@[\w.]+\s*)*(?:abstract\s+|sealed\s+|base\s+|interface\s+|final\s+|mixin\s+)*class\s+([A-Za-z_$]\w*)/,
      getExtends: (line) => {
        const m = line.match(/\bextends\s+([A-Za-z_$][\w$]*)/);
        return m ? m[1]! : null;
      },
    },
    {
      pattern: /^\s*mixin\s+([A-Za-z_$]\w*)/,
      getExtends: (line) => {
        const m = line.match(/\bon\s+([A-Za-z_$][\w$]*)/);
        return m ? m[1]! : null;
      },
    },
    { pattern: /^\s*extension\s+([A-Za-z_$]\w*)\s+on\b/, getExtends: () => null },
    { pattern: /^\s*enum\s+([A-Za-z_$]\w*)/, getExtends: () => null },
  ],

  extractClasses: (lines) => extractDartClasses(lines),

  importPatterns: [
    {
      pattern: /^\s*(?:import|export)\s+['"]([^'"]+)['"]([^;]*);/,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => importSpecifiers(m[2] ?? ""),
    },
  ],

  extractDataSources: (lines) => extractDartDataSources(lines),
  extractRoutes: (lines) => extractDartRoutes(lines),
};
