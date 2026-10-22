import type {
  RouteInfo,
  ClassInfo,
  FunctionInfo,
  DataSourceInfo,
  ParamInfo,
} from "../../../types/analysis.js";
import type { HttpClientRegistration, InteractiveElementInfo, PropertyInfo, RouteFact, ScreenInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractCallsFromBody, extractClassesWithSpec, splitTopLevel } from "../shared/regex-base.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";
import { extractDartRequestAccess, middlewareGuard } from "./request-schema.js";
import {
  applyProviderTypes,
  dartDiCallPatterns,
  dartInitializerQualifier,
  dartInitializerType,
  extractDartDiBindings,
  extractDartLocalTypes,
  riverpodProviderTypes,
} from "./di.js";
import { addBodyLevelMembers, isDartInterface } from "./members.js";
import { singularize } from "../shared/inflection.js";
import { dartRequestBody } from "./request-body.js";
import { goRoutes } from "./go-router.js";
import { dartFieldValues, dartUrlArg, dartVerbArg, extractDartPathArgCalls, isDartHttpReceiver } from "./request-wrappers.js";

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

/**
 * The same definition with its parameter list running onto the next lines
 * (`static Future<RowMetaPB> createRow({` … `}) async {`): `accept` finds the
 * list's end and the body opener after it.
 */
const DART_FUNCTION_WRAPPED = new RegExp(
  String.raw`^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*` +
    String.raw`(?!(?:${STMT_KEYWORDS})\b)` +
    String.raw`(?:(?:external|static|abstract|factory)\s+)*` +
    String.raw`(?:${TYPE_TOKEN}\s+)` +
    String.raw`([A-Za-z_$]\w*)` +
    String.raw`\s*(?:<[^;{(]*>)?\s*\([^)]*$`,
);

/** A method whose return type sits alone on the line above (`static Future<UserProfile>` / `getProfile() async {`). */
const DART_NAME_AFTER_TYPE_LINE = /^\s*([a-z_$][\w$]*)\s*(?:<[^;{(]*>)?\s*\(/;
const TYPE_ONLY_LINE = new RegExp(String.raw`^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:external|static|abstract)\s+)*${TYPE_TOKEN}\s*$`);

/**
 * After the parameter list that opens on line `i` (strings skipped, brackets
 * balanced over up to 40 lines): an `async`/`sync*` marker, then a body (`{`, `=>`),
 * or — with `initializers` — a constructor's `: …` list ending in a body or `;`.
 */
/** `async` / `async*` after the parameter list that opens on line `i`. */
function dartAsyncAfterParams(lines: readonly string[] | undefined, i: number | undefined, line: string): boolean {
  if (!lines || i === undefined) return /\basync\b/.test(line);
  const text = lines.slice(i, i + 40).join("\n");
  let depth = 0;
  for (let k = text.indexOf("("); k >= 0 && k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return /^\s*async\b/.test(text.slice(k + 1));
  }
  return false;
}

function dartBodyFollows(lines: readonly string[], i: number, initializers = false): boolean {
  const text = lines.slice(i, i + 40).join("\n").replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
  const open = text.indexOf("(");
  if (open < 0) return false;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth !== 0) continue;
      const rest = text.slice(k + 1).replace(/^\s*(?:async\*?|sync\*)?\s*/, "");
      if (rest.startsWith("{") || rest.startsWith("=>")) return true;
      if (!initializers || !rest.startsWith(":")) return false;
      // The initializer list runs to the body (`{`) or ends the declaration (`;`).
      let d = 0;
      for (let j = 1; j < rest.length; j++) {
        const ch = rest[j]!;
        if (ch === "(" || ch === "[") d++;
        else if (ch === ")" || ch === "]") d--;
        else if (d === 0 && ch === "{") return true;
        else if (d === 0 && ch === ";") return true;
      }
      return false;
    }
  }
  return false;
}

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

/**
 * Parse a Dart parameter token: `int id`, `String? name`, `this.client`,
 * `{Key? key}`, `required User u`, `@Named('mem') this._repo`. injectable's
 * `@Named('x')` / `@Named.from(Impl)` is the key the parameter is injected by.
 */
function parseDartParam(paramText: string): ParamInfo | null {
  let trimmed = paramText.trim().replace(/^[{[]|[}\]]$/g, "").trim();
  let qualifier: string | undefined;
  let ann: RegExpMatchArray | null;
  while ((ann = trimmed.match(/^@([\w.]+)\s*(?:\(([^)]*)\))?\s*/))) {
    if (ann[1] === "Named" && ann[2] !== undefined) qualifier = ann[2].trim().replace(/^r?(['"])(.*)\1$/s, "$2");
    else if (ann[1] === "Named.from" && ann[2] !== undefined) qualifier = ann[2].trim().replace(/<.*$/s, "");
    trimmed = trimmed.slice(ann[0].length).replace(/^[{[]/, "").trim();
  }
  const param = parseDartParamText(trimmed);
  if (param && qualifier) param.qualifier = qualifier;
  return param;
}

function parseDartParamText(text: string): ParamInfo | null {
  let trimmed = text;
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

/**
 * `<recv>.<verb>(` — global so a line can hold several. The receiver is a
 * client variable, `Dio()`, or a getter call returning one (`this.getDio()`).
 */
const HTTP_CALL_RE = new RegExp(
  String.raw`(?<![\w.])(?:this\.)?((?:[A-Za-z_$]\w*)|Dio\(\)|_?get[A-Z]\w*\(\))\.(${HTTP_VERBS})\s*\(`,
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

/**
 * Drift: `select(_db.userEntity)`, `update(db.remoteAlbumEntity)`, `into(_db.x)`, `delete(_db.x)` — the table getter names the table class.
 * Never a class's static (`MatchEvent.delete(widget.match)`, a Bloc event) or a cascade (`Delta()..delete(n)`).
 */
const DRIFT_STATEMENT_RE = /(?<![\w.])(?:[a-z_]\w*\.)?(select|selectOnly|update|delete|into)\(\s*(?!widget\.)(?:\w+\.)+(\w+)\s*\)/g;
/** Drift: `_db.remoteAssetEntity.delete()`, `db.managers.localAssetEntity.filter(…)`. */
const DRIFT_TABLE_CALL_RE =
  /(?<![\w.])(?:\w*[dD](?:b|atabase)|attachedDatabase|this)(?:\.managers)?\.(\w+)\.(delete|deleteWhere|deleteAll|insert|insertAll|insertOne|insertOnConflictUpdate|insertReturning|update|replace|select|selectOnly|get|getSingle|getSingleOrNull|watch|watchSingle|create|bulkCreate|bulkUpdate|bulkDelete|filter|count)\b/g;
/** Isar: `isar.assets.put(a)` / `_isar.users.where()` — the collection getter is the class, plural. */
const ISAR_CALL_RE = /(?<![\w.])_?isar\.(\w+)\.(put|putAll|putSync|get|getAll|getSync|delete|deleteAll|deleteSync|where|filter|clear|count|watch\w*)\b/g;
const DRIFT_WRITE = /^(delete|deleteWhere|deleteAll|insert\w*|into|update|replace|create|bulk\w+)$/;

const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

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

    // HTTP clients — http / dio / generic clients; `await http` on one line, `.get(…)` on the next.
    const split = new RegExp(String.raw`^(\s*)\.(${HTTP_VERBS})\s*\(`).exec(line);
    let prev = i - 1;
    while (prev >= 0 && !lines[prev]!.trim()) prev--;
    const splitReceiver = split && prev >= 0 ? /(?<![\w.])(?:this\.)?([A-Za-z_$]\w*)\s*$/.exec(lines[prev]!)?.[1] : undefined;
    const httpCalls = [...line.matchAll(HTTP_CALL_RE)].map((m) => ({ receiver: m[1]!, verb: m[2]!, index: m.index!, text: m[0]! }));
    if (split && splitReceiver) httpCalls.unshift({ receiver: splitReceiver, verb: split[2]!, index: split[1]!.length, text: split[0]!.slice(split[1]!.length) });
    for (const m of httpCalls) {
      const { receiver, verb } = m;
      if (!isDartHttpReceiver(receiver)) continue;
      // `apiConnection.request(RequestType.GET, '/x')` is the project's own
      // wrapper, not a client: its call site is a `pathArgCalls` entry.
      const after = line.slice(m.index + m.text.length);
      const firstArg = (after.trim() ? after : lines[i + 1] ?? "").split(",")[0] ?? "";
      if (dartVerbArg(firstArg.replace(/\).*$/, ""))) continue;
      const body = /^(?:post|put|patch)$/i.test(verb) ? dartRequestBody(lines, i, m.index + m.text.length) : null;
      push({
        kind: "api-call",
        name: `${receiver}.${verb}`,
        target: dartUrlArg(lines, i, m.index + m.text.length),
        calls: [],
        line: ln,
        ...(body ? { requestBody: body } : {}),
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

    // Drift — statement builders and table getters; Isar — collection getters.
    for (const m of line.matchAll(DRIFT_STATEMENT_RE)) {
      const entity = pascal(m[2]!);
      push({ kind: "database", name: `${m[1]}(${m[2]})`, target: entity, calls: [], line: ln, entity, access: m[1] === "select" || m[1] === "selectOnly" ? "read" : "write" });
    }
    for (const m of line.matchAll(DRIFT_TABLE_CALL_RE)) {
      if (/^(?:managers|transaction|batch|customStatement|customSelect|customUpdate|executor|select|update|delete|into)$/.test(m[1]!)) continue;
      const entity = pascal(m[1]!);
      push({ kind: "database", name: `db.${m[1]}.${m[2]}`, target: entity, calls: [], line: ln, entity, access: DRIFT_WRITE.test(m[2]!) ? "write" : "read" });
    }
    for (const m of line.matchAll(ISAR_CALL_RE)) {
      if (/^(?:txn|writeTxn|writeTxnSync|collection|close|clear)$/.test(m[1]!)) continue;
      const entity = pascal(singularize(m[1]!));
      push({ kind: "database", name: `isar.${m[1]}.${m[2]}`, target: entity, calls: [], line: ln, entity, access: /^(put|delete|clear)/.test(m[2]!) ? "write" : "read" });
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


/**
 * A shelf `Pipeline` — where the middleware every route behind it inherits is
 * declared:
 *
 *   final handler = const Pipeline()
 *       .addMiddleware(logRequests())
 *       .addMiddleware(authMiddleware())
 *       .addHandler(router);
 *
 * The chain may wrap lines, so it is read as one statement up to its `;`.
 * `addHandler(x)` names the router it wraps; when that identifier is the
 * receiver of route registrations in this file, only those routes inherit
 * the middleware — otherwise (`addHandler(server.router)`, `.call`) every
 * api route in the file does.
 */
interface Pipeline {
  targets: Set<string>;
  middleware: string[];
  guards: GuardAttr[];
}

/** The balanced argument text of the call whose `(` is at `open`, and the index after its `)`. */
function balancedArgs(text: string, open: number): { args: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { args: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function extractPipelines(lines: string[]): Pipeline[] {
  const out: Pipeline[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\bPipeline\s*\(\s*\)/.test(lines[i] ?? "")) continue;
    // The whole statement, up to its `;`.
    let text = "";
    for (let j = i; j < Math.min(lines.length, i + 20); j++) {
      const line = (lines[j] ?? "").replace(/\/\/.*$/, "");
      text += " " + line;
      if (line.includes(";")) break;
    }
    const pipeline: Pipeline = { targets: new Set(), middleware: [], guards: [] };
    const re = /\.(addMiddleware|addHandler)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const call = balancedArgs(text, m.index + m[0].length - 1);
      if (!call) break;
      re.lastIndex = call.end;
      if (m[1] === "addHandler") {
        for (const id of call.args.matchAll(/[A-Za-z_$]\w*/g)) pipeline.targets.add(id[0]);
        continue;
      }
      for (const arg of splitTopLevel(call.args)) {
        const expr = arg.trim();
        if (!expr) continue;
        const guard = middlewareGuard(expr);
        if (guard) pipeline.guards.push(guard);
        else pipeline.middleware.push(expr.replace(/\s+/g, " "));
      }
    }
    if (pipeline.middleware.length > 0 || pipeline.guards.length > 0) out.push(pipeline);
    i += text.split("\n").length - 1;
  }
  return out;
}

function extractDartRoutes(lines: string[], facts?: RouteFact[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  /** Route → the router variable it was registered on. */
  const receiverOf = new Map<RouteInfo, string>();
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
      const route: RouteInfo = {
        path: m[3]!,
        httpMethod: verb.toUpperCase(),
        kind: "api",
        handler: m[4] ?? null,
        calls: [],
        middleware: [],
        line: ln,
      };
      receiverOf.set(route, receiver);
      routes.push(route);
    }

  }
  // GoRouter declarative routes → frontend screens.
  routes.push(...goRoutes(lines, facts));

  // Pipeline middleware is inherited by the routes it wraps. `params` stay
  // absent on purpose: the handler is named, and the project-level join reads
  // its signature (`<id>` ↔ `String id`) and body.
  for (const pipeline of extractPipelines(lines)) {
    const api = routes.filter((r) => r.kind === "api");
    const named = api.filter((r) => pipeline.targets.has(receiverOf.get(r) ?? ""));
    for (const route of named.length > 0 ? named : api) {
      route.middleware.push(...pipeline.middleware);
      applyRouteMeta(route, { inheritedGuards: pipeline.guards });
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

/** Core value types — never a dependency, often a model field. */
const DART_VALUE_TYPES: ReadonlySet<string> = new Set([
  "int", "double", "num", "bool", "String", "DateTime", "Duration", "Uri", "RegExp", "BigInt", "Symbol",
  "List", "Map", "Set", "Object", "dynamic",
]);

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
function extractDartClasses(lines: string[], fns: FunctionInfo[]): ClassInfo[] {
  const classes = extractClassesWithSpec(lines, dartSpec);
  for (const cls of classes) {
    const decl = declarationText(lines, cls.line - 1);
    const seen = new Set<string>(cls.implements ?? []);
    const withM = decl.match(/\bwith\s+([^{]*?)(?:\s+implements\b|\s*\{|$)/);
    if (withM) for (const n of splitTypeList(withM[1]!)) seen.add(n);
    const implM = decl.match(/\bimplements\s+([^{]*?)(?:\s*\{|$)/);
    if (implM) for (const n of splitTypeList(implM[1]!)) seen.add(n);
    cls.implements = [...seen];
    // An enum's value list (`venus(4.8e24);`) is shaped like a signature.
    if (/^\s*enum\b/.test(lines[cls.line - 1] ?? "")) continue;
    addBodyLevelMembers(lines, cls, dartSpec, parseDartParam);
    const values = dartFieldValues(lines, cls);
    if (values) cls.fieldValues = values;
    if (/\bclass\b/.test(decl) && isDartInterface(decl, cls, lines)) cls.kind = "interface";
  }
  // A Riverpod read keyed by a provider declared in this file has that
  // provider's declared type too.
  if (lines.some((l) => l.includes("Provider") || l.includes("riverpod"))) {
    const providers = riverpodProviderTypes(lines);
    applyProviderTypes(fns, providers);
    for (const cls of classes) applyProviderTypes(cls.methods, providers);
  }
  return classes;
}

// ─── Flutter UI (the screen half) ───────────────────────────────────────────

/** Event-handler named arguments on Flutter widgets, with the element each usually sits on. */
const FLUTTER_EVENT_RE =
  /\b(onPressed|onTap|onLongPress|onDoubleTap|onChanged|onSubmitted|onEditingComplete|onSaved|onSelected|onFieldSubmitted|onToggle|onRefresh|onDismissed)\s*:\s*([^,\n]*)/g;

/** Widget constructors by the interactive element they render. */
const FLUTTER_ELEMENT_OF: ReadonlyArray<[RegExp, InteractiveElementInfo["element"]]> = [
  [/\b(?:Elevated|Text|Outlined|Icon|Filled|Floating(?:Action)?|Cupertino|Back|Close|Menu|Popup\w*|Dropdown\w*|Segmented)?Button(?:\.\w+)?\s*\(/, "button"],
  [/\b(?:TextField|TextFormField|CupertinoTextField|EditableText)\s*\(/, "input"],
  [/\bForm\s*\(/, "form"],
  [/\bDropdown\w*\s*\(/, "select"],
  [/\b(?:Checkbox|Switch|Radio|Slider|CupertinoSwitch)\w*\s*\(/, "input"],
  [/\b(?:InkWell|GestureDetector|ListTile|InkResponse|Card|Dismissible|RefreshIndicator)\s*\(/, "custom"],
];

/**
 * `() => _save(ctx)` → `_save`; `_save` → `_save`; `widget.onTap` → `widget.onTap`;
 * `() => Navigator.of(context).pop()` → `Navigator.of`; a block body (`() {`) → null;
 * `null` → null.
 */
function flutterHandlerName(expr: string): string | null {
  let t = expr.trim().replace(/[,;)\s]+$/, "");
  if (!t || t === "null") return null;
  const arrow = t.match(/^\(?[^()]*\)?\s*(?:async\s*)?=>\s*(.*)$/);
  if (arrow) t = arrow[1]!.trim();
  else if (/^\(?[^()]*\)?\s*(?:async\s*)?\{/.test(t)) return null;
  if (/^\{/.test(t)) return null;
  const callee = t.match(/^(?:await\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/);
  return callee ? callee[1]! : null;
}

/** Widget constructor the named argument on line `i` belongs to: the nearest earlier (or same) line opening one. */
function flutterElementAt(lines: string[], i: number): InteractiveElementInfo["element"] {
  for (let j = i; j >= Math.max(0, i - 12); j--) {
    const l = lines[j]!;
    for (const [re, element] of FLUTTER_ELEMENT_OF) if (re.test(l)) return element;
  }
  return "custom";
}

function extractFlutterInteractiveElements(lines: string[]): InteractiveElementInfo[] {
  const out: InteractiveElementInfo[] = [];
  const closures = new Map(flutterClosureHandlers(lines).map((c) => [`${c.line}:${c.column}`, c.name]));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("on")) continue;
    FLUTTER_EVENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FLUTTER_EVENT_RE.exec(line)) !== null) {
      // A declaration (`final VoidCallback? onTap;`, `required this.onTap,`) is no handler.
      if (/\b(?:final|required|this\.|VoidCallback|Function)\b/.test(line.slice(0, m.index + 2))) continue;
      const handler = closures.get(`${i + 1}:${m.index}`) ?? flutterHandlerName(m[2]!);
      out.push({ element: flutterElementAt(lines, i), event: m[1]!, handler, line: i + 1 });
    }
  }
  return out;
}

/** A closure handler: `onPressed: () => unawaited(ref.read(p.notifier).start())`, `onTap: () { … }`. */
interface FlutterClosure {
  /** 1-based line of the `onX:` argument, and its column. */
  line: number;
  column: number;
  /** Pseudo-function name the element's handler names: `<onPressed@218>`. */
  name: string;
  /** 0-based [start, end] line span of the closure, and the columns it starts and ends at. */
  start: number;
  startCol: number;
  end: number;
  endCol: number;
}

/**
 * The inline closures handed to widget events, as spans. A closure has no name
 * of its own, so its element named only the first call in it — `unawaited`,
 * `setState`, `ContextHelper` — and the trace stopped there. Each becomes a
 * pseudo-function `<onPressed@218>` holding the closure's calls (see
 * `flutterClosureFunctions`), the way an inline JS arrow's calls belong to it.
 * A closure that only forwards to one named function (`() => _save(ctx)`)
 * keeps that function as its handler.
 */
function flutterClosureHandlers(lines: string[]): FlutterClosure[] {
  const out: FlutterClosure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("on") || !/[=)]\s*(?:=>|\{|async)/.test(line)) continue;
    FLUTTER_EVENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FLUTTER_EVENT_RE.exec(line)) !== null) {
      if (/\b(?:final|required|this\.|VoidCallback|Function)\b/.test(line.slice(0, m.index + 2))) continue;
      const valueAt = m.index + m[0].length - m[2]!.length;
      const head = line.slice(valueAt).trimStart();
      const closure = /^\([^()]*\)\s*(?:async\s*)?(=>|\{)/.exec(head);
      if (!closure) continue;
      const headAt = valueAt + (line.slice(valueAt).length - head.length);
      const span = closureEnd(lines, i, headAt);
      if (!span) continue;
      // `() => _save(ctx)` forwards to a named function: that name is the handler.
      if (closure[1] === "=>" && span.line === i) {
        const body = line.slice(headAt + closure[0].length, span.col).trim();
        if (/^(?:await\s+)?_?[a-z]\w*\s*\([^()]*\)$/.test(body) && !/^(?:unawaited|setState|print)\b/.test(body)) continue;
      }
      out.push({ line: i + 1, column: m.index, name: `<${m[1]}@${i + 1}>`, start: i, startCol: valueAt, end: span.line, endCol: span.col });
    }
  }
  return out;
}

/** Where the closure starting at `lines[line][col]` ends: the `,`/`)` closing its argument at depth 0, or its block's `}`. */
function closureEnd(lines: string[], line: number, col: number): { line: number; col: number } | null {
  let depth = 0;
  let sawBlock = false;
  for (let l = line; l < Math.min(lines.length, line + 200); l++) {
    const text = lines[l]!;
    for (let c = l === line ? col : 0; c < text.length; c++) {
      const ch = text[c]!;
      if (ch === "/" && text[c + 1] === "/") break;
      if (ch === "'" || ch === '"') {
        const close = text.indexOf(ch, c + 1);
        c = close < 0 ? text.length : close;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        if (ch === "{" && depth === 0 && !sawBlock) sawBlock = true;
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth < 0) return { line: l, col: c };
        if (depth === 0 && ch === "}" && sawBlock) return { line: l, col: c + 1 };
      } else if (ch === "," && depth === 0) return { line: l, col: c };
    }
  }
  return null;
}

/** The closure handlers as pseudo-functions, each with the calls inside its span. */
function flutterClosureFunctions(lines: string[]): FunctionInfo[] {
  if (!lines.some((l) => FLUTTER_EVENT_HINT.test(l))) return [];
  const out: FunctionInfo[] = [];
  for (const c of flutterClosureHandlers(lines)) {
    const span = lines.map((text, i) => {
      if (i < c.start || i > c.end) return "";
      const from = i === c.start ? c.startCol : 0;
      const to = i === c.end ? c.endCol : text.length;
      return " ".repeat(from) + text.slice(from, to);
    });
    const calls = extractCallsFromBody(span, c.start, c.end + 1, dartSpec.lineCommentPrefixes, dartSpec.callPatterns);
    if (calls.length === 0) continue;
    out.push({ name: c.name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls, line: c.line, endLine: c.end + 1 });
  }
  return out;
}

const FLUTTER_EVENT_HINT = /\bon(?:Pressed|Tap|LongPress|DoubleTap|Changed|Submitted|EditingComplete|Saved|Selected|FieldSubmitted|Toggle|Refresh|Dismissed)\s*:/;

/** Widget base classes whose subclasses can be screens. */
const FLUTTER_WIDGET_BASE_RE =
  /^(?:StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|StatelessHookWidget|StatefulHookWidget|StatelessHookConsumerWidget|StatefulHookConsumerWidget)$/;
/** `Navigator.push(context, … (_) => SettingsPage())` / `context.push('/settings')` / `context.push(SettingsPage.routeName)` / `context.router.push(SettingsRoute())` / `showDialog(… SettingsDialog(`. */
const FLUTTER_NAV_RE = [
  /\bcontext\.(?:push|go|replace|pushReplacement|pushNamed|goNamed)\s*\(\s*(?:['"]([^'"]+)['"]|([A-Z]\w*)\.(?:routeName|routePath|route|path|name)\b)/g,
  /\b(?:Navigator(?:\.of\(\w+\))?|context\.router|router|_router|appRouter)\.(?:push|pushReplacement|pushAndRemoveUntil|navigate|replace)\w*\s*\([^;]*?\b(?:=>\s*(?:const\s+)?|\(\s*)([A-Z]\w*)(?:Route|Page|Screen)?\s*\(/g,
  /\bshow(?:Dialog|ModalBottomSheet|CupertinoDialog|GeneralDialog|Menu)\s*(?:<[^>]*>)?\s*\([^;]*?=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/g,
];

/**
 * Flutter screens: a widget class that renders a `Scaffold` (or a Cupertino
 * page scaffold), is annotated `@RoutePage`, or is named `*Page` / `*Screen`.
 * A `State<X>` class belongs to the screen `X` — its body is scanned for the
 * screen's navigation. `components` stay empty: the widget tree is code, not a
 * designer file; the interactive elements carry the handlers.
 */
function extractFlutterScreens(lines: string[], filePath: string, classes: ClassInfo[]): ScreenInfo[] {
  const screens: ScreenInfo[] = [];
  const stateOf = new Map<string, ClassInfo>(); // screen class → its State class
  for (const cls of classes) {
    const m = cls.extends?.match(/^State<\s*([A-Z]\w*)/);
    if (m) stateOf.set(m[1]!, cls);
  }
  const bodyOf = (cls: ClassInfo): string => lines.slice(cls.line - 1, cls.endLine).join("\n");
  for (const cls of classes) {
    const base = cls.extends?.replace(/<.*$/, "") ?? "";
    if (!FLUTTER_WIDGET_BASE_RE.test(base)) continue;
    const state = stateOf.get(cls.name);
    const body = bodyOf(cls) + (state ? "\n" + bodyOf(state) : "");
    const annotated = cls.decorators.some((d) => /^RoutePage\b/.test(d)) || /@RoutePage\b/.test(lines[Math.max(0, cls.line - 2)] ?? "");
    const scaffold = /\b(?:Scaffold|CupertinoPageScaffold|CupertinoTabScaffold|AdaptiveScaffold)\s*(?:\.\w+\s*)?\(/.test(body);
    if (!annotated && !scaffold && !/(?:Page|Screen)$/.test(cls.name)) continue;
    const navigatesTo = new Set<string>();
    for (const re of FLUTTER_NAV_RE) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const target = m[1] ?? m[2];
        if (target && target !== cls.name) navigatesTo.add(target);
      }
    }
    screens.push({
      name: cls.name,
      formType: "FlutterPage",
      caption: null,
      dimensions: null,
      components: [],
      filePath,
      routePath: null,
      navigatesTo: [...navigatesTo],
    });
  }
  return screens;
}

/**
 * The API classes of an OpenAPI-generated Dart client (`package:openapi/api.dart`,
 * often a gitignored path dependency): `final AlbumsApi _api;` makes `_api.createAlbum(…)`
 * the spec's `createAlbum` operation of the `Albums` tag. Each `*Api` type the file
 * names is registered as a proxy of itself, so the call carries that contract.
 */
function generatedApiClients(lines: string[]): HttpClientRegistration[] {
  if (!lines.some((l) => /^\s*import\s+['"]package:openapi\//.test(l))) return [];
  const out: HttpClientRegistration[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (/^\s*import\b/.test(l)) return;
    for (const m of l.matchAll(/\b([A-Z]\w*Api)\b(?=\s+[_a-z]\w*\s*[;=,)]|\s*\()/g)) {
      if (seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      out.push({ client: m[1]!, scope: "project", proxyOf: m[1]!, line: i + 1 });
    }
  });
  return out;
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
    {
      pattern: DART_FUNCTION_WRAPPED,
      isExported: (_line, name) => !name.startsWith("_"),
      isAsync: (line, lines, i) => dartAsyncAfterParams(lines, i, line),
      accept: (lines, i) => dartBodyFollows(lines, i, false),
    },
    {
      pattern: DART_NAME_AFTER_TYPE_LINE,
      isExported: (_line, name) => !name.startsWith("_"),
      isAsync: (line, lines, i) => dartAsyncAfterParams(lines, i, line),
      accept: (lines, i) => i > 0 && TYPE_ONLY_LINE.test(lines[i - 1]!) && !/^\s*(?:return|await)\b/.test(lines[i - 1]!) && dartBodyFollows(lines, i, false),
    },
  ],

  parseParam: parseDartParam,
  parseReturnType: parseDartReturnType,

  /**
   * Fields: `final int id;`, `String? name;`, `late List<String> tags;`,
   * `int count = 0;`. A type is required (an untyped `var x = …` is skipped),
   * and only declarations at the class body's own brace depth count, so a
   * method local never becomes a field. Annotations sit inline
   * (`@JsonKey(name: 'x') final String name;`) or on their own line above
   * (`attributeLine`); both become decorators with the `@` dropped. A
   * non-nullable field without an initializer must be set by every
   * constructor — and by every `fromJson` — so it is `isRequired`.
   */
  propertyPatterns: [
    {
      pattern: new RegExp(
        String.raw`^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)` + // (1) inline annotations
          String.raw`(?:(static)\s+)?((?:(?:final|const|late)\s+)*)` + // (2) static, (3) final/const/late
          String.raw`(?!(?:${STMT_KEYWORDS}|abstract|class|enum|mixin|extension|external|factory|operator|typedef|void)\b)` +
          String.raw`([A-Za-z_$][\w$.]*(?:<[^;=]*>)?\??)\s+` + // (4) type
          String.raw`([A-Za-z_$]\w*)\s*` + // (5) name
          String.raw`(?:(=)\s*.*|;)\s*$`, // (6) `=` when initialised
      ),
      build: (m, line) => {
        const type = m[4]!;
        const decorators = [...m[1]!.matchAll(/@([\w.]+(?:\([^)]*\))?)/g)].map((d) => d[1]!.replace(/\s+/g, " "));
        const prop: PropertyInfo = {
          name: m[5]!,
          type,
          visibility: m[5]!.startsWith("_") ? "private" : "public",
          isStatic: m[2] === "static" || /\bconst\b/.test(m[3]!),
          isReadonly: /\b(?:final|const)\b/.test(m[3]!),
        };
        if (decorators.length > 0) prop.decorators = decorators;
        if (m[6] !== "=" && !type.endsWith("?") && type !== "dynamic" && !prop.isStatic) prop.isRequired = true;
        if (m[6] === "=") {
          // `final UserRepo repo = getIt<UserRepo>(instanceName: 'pg');`
          const q = dartInitializerQualifier(line.slice(line.indexOf("=", line.indexOf(m[5]!) + m[5]!.length) + 1));
          if (q) prop.qualifier = q;
        }
        return prop;
      },
    },
    {
      // An untyped field whose initializer states its type — a construction
      // or a container lookup (`final _repo = getIt.get<UserRepo>();`,
      // `late final repo = PgRepo();`). Value types are left out so a model's
      // shape (`final createdAt = DateTime.now();`) is unchanged.
      pattern: /^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)(?:(static)\s+)?((?:(?:final|const|late|var)\s+)+)([A-Za-z_$]\w*)\s*=\s*(.+?)\s*;\s*$/,
      build: (m) => {
        const init = dartInitializerType(m[5]!);
        if (!init || DART_VALUE_TYPES.has(init.type.replace(/[<?].*$/s, ""))) return null;
        const prop: PropertyInfo = {
          name: m[4]!,
          type: init.type || null,
          visibility: m[4]!.startsWith("_") ? "private" : "public",
          isStatic: m[2] === "static" || /\bconst\b/.test(m[3]!),
          isReadonly: /\b(?:final|const)\b/.test(m[3]!),
        };
        if (init.qualifier) prop.qualifier = init.qualifier;
        return prop.type || prop.qualifier ? prop : null;
      },
    },
  ],

  /** `@JsonKey(name: 'created_at')` / `@override` on the line above a declaration. */
  attributeLine: { pattern: /^\s*@([\w.]+(?:\([^)]*\))?)\s*$/ },

  extractRequestAccess: extractDartRequestAccess,

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

  extractClasses: (lines, fns) => extractDartClasses(lines, fns),

  callPatterns: dartDiCallPatterns,
  extractLocalTypes: extractDartLocalTypes,
  extractDiBindings: (lines) => extractDartDiBindings(lines),

  importPatterns: [
    {
      pattern: /^\s*(?:import|export)\s+['"]([^'"]+)['"]([^;]*);/,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => importSpecifiers(m[2] ?? ""),
    },
  ],

  extractDataSources: (lines) => extractDartDataSources(lines),
  // Call sites of a project request wrapper (`ApiConnection().request(RequestType.GET, '/x')`).
  extractPathArgCalls: extractDartPathArgCalls,
  extractHttpClientRegistrations: (lines) => generatedApiClients(lines),
  extractRoutes: (lines, _classes, _file, _functions, facts) => extractDartRoutes(lines, facts),
  extractInteractiveElements: (lines) => extractFlutterInteractiveElements(lines),
  // Inline closure handlers as functions of their own (see `flutterClosureFunctions`).
  postProcessFunctions: (lines, fns) => {
    const closures = flutterClosureFunctions(lines);
    if (closures.length === 0) return fns;
    if (lines.some((l) => l.includes("Provider") || l.includes("riverpod"))) applyProviderTypes(closures, riverpodProviderTypes(lines));
    return [...fns, ...closures];
  },
  extractScreens: (lines, filePath, classes) => extractFlutterScreens(lines, filePath, classes),
};
