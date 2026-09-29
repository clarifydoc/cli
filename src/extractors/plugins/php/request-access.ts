import type { ParamInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { pathParamNames, type GuardAttr } from "../../shared/route-metadata.js";

/**
 * What a PHP handler reads from the HTTP request, and where a typed handler
 * parameter binds from — the two facts a Laravel / Symfony / CodeIgniter
 * route needs that its registration line never shows.
 *
 * Laravel's handler lives in a controller file the `routes/*.php` extractor
 * cannot see, so the function extractor records `requestAccess` on every
 * method that touches a request object, and `bindPhpParam` (exposed through
 * `meta.requestSchema.bindParam`) types the signature; the project-level join
 * in `core/request-schemas.ts` copies both onto the route. Symfony and
 * CodeIgniter have the method node in hand and call the same helpers directly.
 *
 * Text-based on purpose: the receiver is a `$request`-style variable and the
 * accessors are a fixed vocabulary, so a regex over the body is exact where it
 * matches and silent where it does not.
 */

/** Framework-injected types a handler receives but a caller never sends. */
const SERVICE_TYPES: ReadonlySet<string> = new Set([
  "Request", "Response", "JsonResponse", "RedirectResponse", "StreamedResponse", "BinaryFileResponse",
  "ServerRequestInterface", "ResponseInterface", "RequestInterface", "ResponseFactoryInterface",
  "Closure", "Session", "SessionInterface", "Security", "UserInterface", "TokenInterface",
  "LoggerInterface", "EntityManagerInterface", "ManagerRegistry", "SerializerInterface",
  "ValidatorInterface", "TranslatorInterface", "EventDispatcherInterface", "MessageBusInterface",
  "UrlGeneratorInterface", "RouterInterface", "Environment", "Container", "ContainerInterface",
  "Application", "Guard", "Gate", "Auth", "Authenticatable", "Factory", "Redirector", "ResponseFactory",
]);

const SCALAR_TYPES: ReadonlySet<string> = new Set(["int", "float", "string", "bool", "array", "mixed", "iterable", "object", "callable"]);

function bareType(type: string | null): string | null {
  if (!type) return null;
  return type.replace(/^\?/, "").replace(/^\\/, "").replace(/.*\\/, "").replace(/\|null$/i, "").trim() || null;
}

/** A type the framework injects rather than binds from the request. */
export function isServiceType(type: string | null): boolean {
  const t = bareType(type);
  return !!t && (SERVICE_TYPES.has(t) || /(Service|Repository|Manager|Interface|Handler|Factory|Logger|Bus)$/.test(t));
}

/** A Laravel `FormRequest` subclass (`StoreOrderRequest`) — the validated request body. */
export function isFormRequestType(type: string | null): boolean {
  const t = bareType(type);
  return !!t && t !== "Request" && /Request$/.test(t) && !SERVICE_TYPES.has(t);
}

/**
 * Where a PHP handler parameter binds from, by type and path — the rule the
 * frameworks share: path tokens are route values (implicit route-model
 * binding included), injected types are services, a FormRequest is the body.
 * A scalar or class not named by the path says nothing (null): Laravel would
 * resolve it from the container, or it is a signature the route does not feed.
 */
export function bindPhpParam(name: string, type: string | null, path: string): RouteParamBinding | null {
  if (pathParamNames(path).has(name.toLowerCase())) return "route";
  if (isServiceType(type)) return "services";
  if (isFormRequestType(type)) return "body";
  return null;
}

/** `bindPhpParam` over a whole signature, in `RouteParamInfo` shape (everything here is inferred). */
export function bindPhpParams(params: readonly ParamInfo[], path: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  for (const p of params) {
    if (!p.name || p.name === "_") continue;
    const binding = bindPhpParam(p.name, p.type, path);
    out.push(binding ? { name: p.name, type: p.type, binding, inferred: true } : { name: p.name, type: p.type, binding: null });
  }
  return out;
}

/** Parameter names that hold the request object: `Request $request`, `$req`, any `*Request` type. */
export function requestReceivers(params: readonly ParamInfo[]): string[] {
  const out: string[] = [];
  for (const p of params) {
    if (!p.name) continue;
    const t = bareType(p.type);
    if (p.name === "request" || p.name === "req" || (t && /Request(Interface)?$/.test(t))) out.push(p.name);
  }
  return out;
}

// ─── Body scan ──────────────────────────────────────────────────────────────

/** Laravel input accessors that read one named field of the request body. */
const BODY_ACCESSORS = "input|get|post|json|string|str|integer|boolean|float|date|enum|has|filled|missing|exists|collect|anyFilled|isNotFilled";
/** Laravel validation rule → PHP type of the field, for the schema. */
const RULE_TYPES: ReadonlyArray<[RegExp, string]> = [
  [/\b(integer|int)\b/, "int"],
  [/\b(numeric|decimal)\b/, "float"],
  [/\b(boolean|bool)\b/, "bool"],
  [/\barray\b/, "array"],
  [/\b(date|date_format|before|after)\b/, "DateTime"],
  [/\b(file|image|mimes)\b/, "UploadedFile"],
  [/\b(string|email|url|uuid|ip|json|alpha|alpha_num|alpha_dash)\b/, "string"],
];

export function ruleType(rules: string): string | null {
  for (const [re, t] of RULE_TYPES) if (re.test(rules)) return t;
  return null;
}

function accessorType(method: string): string | null {
  switch (method) {
    case "integer": case "getInt": return "int";
    case "boolean": case "getBoolean": return "bool";
    case "float": return "float";
    case "string": case "str": case "getString": case "getAlpha": case "getAlnum": case "getDigits": return "string";
    case "date": return "DateTime";
    default: return null;
  }
}

/** The text of the `[...]` array literal that starts at `open` (index of `[`), balanced. */
export function arrayLiteralAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** `'name' => 'required|string'` pairs of a validation-rules array (nested `'items.*.sku'` keys kept as written). */
export function ruleEntries(arrayText: string): Array<{ name: string; rules: string }> {
  const out: Array<{ name: string; rules: string }> = [];
  for (const m of arrayText.matchAll(/(['"])([\w.*-]+)\1\s*=>\s*(?:(['"])((?:(?!\3).)*)\3|\[((?:[^\][]|\[[^\]]*\])*)\])/g)) {
    out.push({ name: m[2]!, rules: m[4] ?? m[5] ?? "" });
  }
  return out;
}

function escapeVar(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every request field a handler body reads, by binding. `receivers` are the
 * variable names holding the request (`request` for `$request->…`); Laravel's
 * global `request()` helper is always honoured. `$this->validate($r, [...])`
 * and `Validator::make($r->all(), [...])` contribute their rule keys.
 */
export function extractPhpRequestAccess(bodyText: string, receivers: readonly string[]): RouteParamInfo[] {
  if (receivers.length === 0 && !bodyText.includes("request(")) return [];
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const push = (name: string, binding: RouteParamBinding, type: string | null = null): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type, binding });
  };

  // `request()->input('x')` and `request('x')` read like a `$request` receiver.
  const text = bodyText.replace(/\brequest\(\)/g, "$__request").replace(/(?<![\w$>])request\(\s*(['"])/g, "$__request->input($1");
  const vars = [...new Set([...receivers, "__request"])].map(escapeVar).join("|");
  const recv = `\\$(?:${vars})`;
  // Named backreference: `S` follows a capturing accessor group in some patterns and none in others.
  const S = `\\s*(?<q>['"])([^'"]+)\\k<q>`;

  // Body fields: `$request->input('x')`, `->string('x')`, Symfony `->request->get('x')`, magic `$request->x`.
  for (const m of text.matchAll(new RegExp(`${recv}->(${BODY_ACCESSORS})\\(${S}`, "g"))) push(m[3]!, "body", accessorType(m[1]!));
  for (const m of text.matchAll(new RegExp(`${recv}->request->(get|getInt|getBoolean|getString|has|all)\\(${S}`, "g"))) push(m[3]!, "body", accessorType(m[1]!));
  for (const m of text.matchAll(new RegExp(`${recv}->(?:only|except)\\(\\s*(\\[[^\\]]*\\])`, "g"))) {
    for (const s of m[1]!.matchAll(/(['"])([^'"]+)\1/g)) push(s[2]!, "body");
  }
  for (const m of text.matchAll(new RegExp(`${recv}->([a-z_]\\w*)(?![\\w(>])`, "g"))) {
    if (!MAGIC_STOPLIST.has(m[1]!)) push(m[1]!, "body");
  }
  // Query: `->query('q')`, Symfony `->query->get('q')`.
  for (const m of text.matchAll(new RegExp(`${recv}->query\\(${S}`, "g"))) push(m[2]!, "query");
  for (const m of text.matchAll(new RegExp(`${recv}->query->(get|getInt|getBoolean|getString|getAlpha|getAlnum|getDigits|has)\\(${S}`, "g"))) push(m[3]!, "query", accessorType(m[1]!));
  // Header: `->header('X')`, `->hasHeader`, Symfony `->headers->get('X')`, `->bearerToken()`.
  for (const m of text.matchAll(new RegExp(`${recv}->(?:header|hasHeader)\\(${S}`, "g"))) push(m[2]!, "header");
  for (const m of text.matchAll(new RegExp(`${recv}->headers->(?:get|has)\\(${S}`, "g"))) push(m[2]!, "header");
  if (new RegExp(`${recv}->bearerToken\\(`).test(text)) push("Authorization", "header");
  // Route: `->route('id')`, Symfony `->attributes->get('id')`.
  for (const m of text.matchAll(new RegExp(`${recv}->route\\(${S}`, "g"))) push(m[2]!, "route");
  for (const m of text.matchAll(new RegExp(`${recv}->attributes->get\\(${S}`, "g"))) push(m[2]!, "route");
  // Form (multipart): `->file('f')`, `->hasFile('f')`, Symfony `->files->get('f')`.
  for (const m of text.matchAll(new RegExp(`${recv}->(?:file|hasFile)\\(${S}`, "g"))) push(m[2]!, "form", "UploadedFile");
  for (const m of text.matchAll(new RegExp(`${recv}->files->get\\(${S}`, "g"))) push(m[2]!, "form", "UploadedFile");

  // Validation rules: `$request->validate([...])`, `$this->validate($request, [...])`, `Validator::make($request->all(), [...])`.
  const ruleArrays = [
    new RegExp(`${recv}->validate(?:WithBag\\([^,]*,)?\\(\\s*(?=\\[)`, "g"),
    new RegExp(`\\$this->validate\\(\\s*${recv}\\s*,\\s*(?=\\[)`, "g"),
    new RegExp(`Validator::make\\(\\s*${recv}->all\\(\\)\\s*,\\s*(?=\\[)`, "g"),
  ];
  for (const re of ruleArrays) {
    for (const m of text.matchAll(re)) {
      const open = text.indexOf("[", m.index! + m[0].length - 1);
      if (open < 0) continue;
      for (const e of ruleEntries(arrayLiteralAt(text, open))) push(e.name, "body", ruleType(e.rules));
    }
  }
  // The whole body: `->all()`, `->validated()`, `->getContent()`, `->toArray()`, `->getPayload()`.
  if (new RegExp(`${recv}->(?:all|validated|getContent|toArray|getPayload|safe)\\(`).test(text)) push("body", "body");
  return out;
}

/**
 * Members of Laravel's / Symfony's Request that are NOT input fields when
 * spelled as a bare property access (`$request->user` is not a body field;
 * `$request->query->…` is a bag).
 */
const MAGIC_STOPLIST: ReadonlySet<string> = new Set([
  "query", "request", "attributes", "headers", "files", "cookies", "server", "session", "user",
  "route", "method", "url", "path", "ip", "content", "format", "locale", "input", "json", "all",
  "expects_json", "expectsjson", "ajax", "secure", "is", "has",
]);

// ─── Laravel middleware → guards ───────────────────────────────────────────

/**
 * A Laravel middleware string as a guard: `auth`/`auth:sanctum`/`auth.basic`
 * name the scheme, `role:` / `role_or_permission:` name roles, `can:` /
 * `permission:` / `abilities:` / `verified` / `signed` / `password.confirm`
 * are checks (policies), `guest` waives the rest. Anything else (`throttle`,
 * `web`, `cors`, an app class) is plain middleware and returns null — it still
 * belongs in `route.middleware`, just not in `auth`.
 */
export function laravelGuard(mw: string): GuardAttr | null {
  const [name, argText = ""] = mw.split(":", 2) as [string, string?];
  const args = argText.split(",").map((s) => s.trim()).filter(Boolean);
  switch (name) {
    case "auth":
      return { text: mw, schemes: args.length > 0 ? args : ["auth"] };
    case "auth.basic":
      return { text: mw, schemes: ["basic"] };
    case "auth.session":
      return { text: mw, schemes: ["session"] };
    case "role":
    case "role_or_permission":
      return { text: mw, roles: args.flatMap((a) => a.split("|")) };
    case "can":
    case "permission":
    case "abilities":
    case "ability":
    case "scope":
    case "scopes":
    case "verified":
    case "signed":
    case "password.confirm":
      return { text: mw, policies: [mw] };
    case "guest":
      return { text: mw, anonymous: true };
    default:
      return null;
  }
}
