import type { Node } from "web-tree-sitter";
import type { RouteFact } from "../../../../types/analysis.js";
/** A Python string literal's content: `r"^api/"`, `'x'`, `"""doc"""` → what is between the quotes. */
function pyString(text: string): string {
  const m = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(text);
  return m ? m[2]! : text;
}

/**
 * What one Python file says about Django / Django REST Framework routing.
 * None of it is a route on its own — a urlconf's paths are prefixes of what
 * the urlconfs including it say, a `router.register` expands into routes only
 * once its ViewSet's base classes (often in another file) are known — so the
 * file records facts and `django-urlconf` (resolver.ts) joins them.
 */
export const DJ_URLPATTERNS = "dj:urlpatterns";
export const DJ_ROOT_URLCONF = "dj:root-urlconf";
export const DRF_ROUTER = "drf:router";
export const DRF_REGISTER = "drf:register";
export const DJ_VIEW_CLASS = "dj:view-class";
/** `REST_FRAMEWORK = {"DEFAULT_PERMISSION_CLASSES": [...]}` in settings: what a DRF view states nothing of. */
export const DRF_SETTINGS = "drf:settings";
/** `app_name = "clubs"` in a urlconf: the namespace its route names sit in (`clubs:detail`). */
export const DJ_APP_NAME = "dj:app-name";

/** A view a urlconf entry names, as written. */
export type ViewRef =
  | { kind: "class"; name: string; actions?: Record<string, string> }
  | { kind: "func"; name: string };

export type IncludeTarget = (
  | { kind: "module"; spec: string }
  | { kind: "list"; entries: UrlEntry[] }
  | { kind: "var"; name: string }
  | { kind: "router"; name: string }
  | { kind: "external" }
) & {
  /** `include(…, namespace="x")`, or the app name of `include(([…], "x"))`. */
  namespace?: string;
};

/** One urlconf entry. `route` is null when it is not a literal (`path(settings.BASE_PATH, …)`). */
export type UrlEntry =
  | { t: "view"; route: string | null; regex: boolean; line: number; view: ViewRef; name?: string }
  | { t: "include"; route: string | null; regex: boolean; line: number; target: IncludeTarget }
  | { t: "router"; name: string; line: number };

export interface DrfRouterFact {
  ctor: string;
  trailingSlash: boolean;
}

export interface DrfRegisterFact {
  prefix: string;
  viewset: string;
}

export interface DrfSettingsFact {
  permissionClasses: string[];
}

/** Class attributes DRF reads at runtime, which the class extractor does not keep. */
export interface DjViewClassFact {
  lookupField?: string;
  lookupUrlKwarg?: string;
  httpMethodNames?: string[];
  permissionClasses?: string[];
}

/** Cheap text gate: only files mentioning one of these get walked. */
export const DJANGO_GATE = /urlpatterns|\.register\(|ROOT_URLCONF|lookup_field|lookup_url_kwarg|http_method_names|permission_classes|REST_FRAMEWORK/;

const URL_FUNCS = new Set(["path", "re_path", "url"]);

export function collectDjangoFacts(root: Node, facts: RouteFact[]): void {
  for (const stmt of root.namedChildren) {
    if (stmt.type === "class_definition") {
      classFact(stmt, facts);
      continue;
    }
    if (stmt.type === "decorated_definition") {
      const def = stmt.childForFieldName("definition");
      if (def?.type === "class_definition") classFact(def, facts);
      continue;
    }
    if (stmt.type !== "expression_statement") continue;
    const expr = stmt.namedChild(0);
    if (!expr) continue;
    const line = expr.startPosition.row + 1;

    if (expr.type === "assignment" || expr.type === "augmented_assignment") {
      const left = expr.childForFieldName("left");
      const right = expr.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      const name = left.text;
      if (name === "app_name" && right.type === "string") {
        facts.push({ kind: DJ_APP_NAME, line, data: { name: pyString(right.text) } });
        continue;
      }
      if (name === "REST_FRAMEWORK" && right.type === "dictionary") {
        const perms = dictList(right, "DEFAULT_PERMISSION_CLASSES");
        if (perms) facts.push({ kind: DRF_SETTINGS, line, data: { permissionClasses: perms } satisfies DrfSettingsFact });
        continue;
      }
      if (name === "ROOT_URLCONF" && right.type === "string") {
        facts.push({ kind: DJ_ROOT_URLCONF, line, data: { module: pyString(right.text) } });
        continue;
      }
      const router = routerCtor(right);
      if (router) {
        facts.push({ kind: DRF_ROUTER, line, owner: name, data: router });
        continue;
      }
      const entries = urlList(right);
      if (entries && (name === "urlpatterns" || entries.length > 0)) {
        facts.push({ kind: DJ_URLPATTERNS, line, owner: name, data: { entries } });
      }
      continue;
    }

    // `router.register(r"tags", TagViewSet)` / `urlpatterns.append(path(…))`
    if (expr.type === "call") {
      const fn = expr.childForFieldName("function");
      if (fn?.type !== "attribute") continue;
      const obj = fn.childForFieldName("object");
      const method = fn.childForFieldName("attribute")?.text;
      const args = positional(expr);
      if (method === "register" && obj?.type === "identifier" && args[0]?.type === "string" && args[1]) {
        facts.push({
          kind: DRF_REGISTER,
          line,
          owner: obj.text,
          data: { prefix: pyString(args[0].text), viewset: args[1].text } satisfies DrfRegisterFact,
        });
      } else if ((method === "append" || method === "extend") && obj?.type === "identifier" && args[0]) {
        const entries = method === "append" ? [urlEntry(args[0])].filter((e): e is UrlEntry => !!e) : urlList(args[0]);
        if (entries?.length) facts.push({ kind: DJ_URLPATTERNS, line, owner: obj.text, data: { entries } });
      }
    }
  }
}

/** `DefaultRouter()` / `SimpleRouter(trailing_slash=False)` / `NetBoxRouter()` — any `*Router(...)` call. */
function routerCtor(node: Node): DrfRouterFact | null {
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  const ctor = fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text : fn?.text;
  if (!ctor || !/Router$/.test(ctor) || /APIRouter$/.test(ctor)) return null;
  const ts = keyword(node, "trailing_slash");
  return { ctor, trailingSlash: !(ts?.text === "False" || (ts?.type === "string" && pyString(ts.text) === "")) };
}

/** A urlconf list: `[path(…), …]`, `format_suffix_patterns([...])`, `router.urls`, a `+` of those. */
function urlList(node: Node): UrlEntry[] | null {
  if (node.type === "list" || node.type === "tuple") {
    const out: UrlEntry[] = [];
    let any = false;
    for (const el of node.namedChildren) {
      if (el.type === "list_splat") {
        const inner = el.namedChild(0);
        const router = inner ? routerUrls(inner) : null;
        if (router) {
          out.push({ t: "router", name: router, line: el.startPosition.row + 1 });
          any = true;
        }
        continue;
      }
      const e = urlEntry(el);
      if (e) {
        out.push(e);
        any = true;
      }
    }
    return any || node.namedChildren.length === 0 ? out : null;
  }
  if (node.type === "binary_operator") {
    const left = urlList(node.childForFieldName("left")!);
    const right = urlList(node.childForFieldName("right")!);
    return left || right ? [...(left ?? []), ...(right ?? [])] : null;
  }
  const router = routerUrls(node);
  if (router) return [{ t: "router", name: router, line: node.startPosition.row + 1 }];
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    if (fn?.text === "format_suffix_patterns" || fn?.text?.endsWith(".format_suffix_patterns")) {
      const arg = positional(node)[0];
      return arg ? urlList(arg) : null;
    }
  }
  return null;
}

/** `router.urls` → "router". */
function routerUrls(node: Node): string | null {
  if (node.type !== "attribute" || node.childForFieldName("attribute")?.text !== "urls") return null;
  const obj = node.childForFieldName("object");
  return obj?.type === "identifier" ? obj.text : null;
}

/** `path("x/", view)` / `re_path(r"^x/", include(...))` / `url(...)`. */
function urlEntry(node: Node): UrlEntry | null {
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  const name = fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text : fn?.text;
  if (!name || !URL_FUNCS.has(name)) return null;
  const args = positional(node);
  const routeNode = args[0];
  const viewNode = args[1] ?? keyword(node, "view");
  if (!routeNode || !viewNode) return null;
  const route = routeNode.type === "string" ? pyString(routeNode.text) : null;
  const regex = name !== "path";
  const line = node.startPosition.row + 1;

  const include = includeTarget(viewNode);
  if (include) return { t: "include", route, regex, line, target: include };
  // `path("api/", router.urls)` is an include of the router; `admin.site.urls` one we cannot see.
  if (viewNode.type === "attribute" && viewNode.childForFieldName("attribute")?.text === "urls") {
    const router = routerUrls(viewNode);
    return { t: "include", route, regex, line, target: router ? { kind: "router", name: router } : { kind: "external" } };
  }
  const view = viewRef(viewNode);
  const named = keyword(node, "name");
  const routeName = named?.type === "string" ? pyString(named.text) : null;
  return view ? { t: "view", route, regex, line, view, ...(routeName ? { name: routeName } : {}) } : null;
}

function includeTarget(node: Node): IncludeTarget | null {
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.text !== "include" && !fn?.text?.endsWith(".include")) return null;
  let arg = positional(node)[0];
  const nsArg = keyword(node, "namespace");
  let namespace = nsArg?.type === "string" ? pyString(nsArg.text) : undefined;
  // `include(([...], "app_name"), namespace=…)` — the patterns are the tuple's first item.
  if (arg?.type === "tuple") {
    const app = arg.namedChildren[1];
    if (!namespace && app?.type === "string") namespace = pyString(app.text);
    arg = arg.namedChildren[0];
  }
  const ns = namespace ? { namespace } : {};
  if (!arg) return { kind: "external" };
  if (arg.type === "string") return { kind: "module", spec: pyString(arg.text), ...ns };
  if (arg.type === "list") return { kind: "list", entries: urlList(arg) ?? [], ...ns };
  const router = routerUrls(arg);
  if (router) return { kind: "router", name: router, ...ns };
  if (arg.type === "identifier") return { kind: "var", name: arg.text, ...ns };
  return { kind: "external" };
}

/** `ListView.as_view()`, `TagViewSet.as_view({"get": "list"})`, `views.login`. */
function viewRef(node: Node): ViewRef | null {
  if (node.type === "call") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "as_view") {
      const cls = fn.childForFieldName("object")?.text;
      if (!cls) return null;
      const mapping = positional(node)[0];
      if (mapping?.type === "dictionary") {
        const actions: Record<string, string> = {};
        for (const pair of mapping.namedChildren) {
          if (pair.type !== "pair") continue;
          const k = pair.childForFieldName("key");
          const v = pair.childForFieldName("value");
          if (k?.type === "string" && v?.type === "string") actions[pyString(k.text).toLowerCase()] = pyString(v.text);
        }
        return { kind: "class", name: cls, actions };
      }
      return { kind: "class", name: cls };
    }
    // A decorated view wrapped at the call site (`csrf_exempt(views.hook)`): the view is the argument.
    const inner = positional(node)[0];
    return inner && (inner.type === "identifier" || inner.type === "attribute") ? { kind: "func", name: inner.text } : null;
  }
  if (node.type === "identifier" || node.type === "attribute") return { kind: "func", name: node.text };
  return null;
}

function classFact(cls: Node, facts: RouteFact[]): void {
  const name = cls.childForFieldName("name")?.text;
  const body = cls.childForFieldName("body");
  if (!name || !body) return;
  const data: DjViewClassFact = {};
  for (const stmt of body.namedChildren) {
    const expr = stmt.type === "expression_statement" ? stmt.namedChild(0) : null;
    if (expr?.type !== "assignment") continue;
    const left = expr.childForFieldName("left")?.text;
    const right = expr.childForFieldName("right");
    if (!right) continue;
    if (left === "lookup_field" && right.type === "string") data.lookupField = pyString(right.text);
    else if (left === "lookup_url_kwarg" && right.type === "string") data.lookupUrlKwarg = pyString(right.text);
    else if (left === "http_method_names" && (right.type === "list" || right.type === "tuple")) {
      data.httpMethodNames = right.namedChildren.filter((c) => c.type === "string").map((c) => pyString(c.text).toLowerCase());
    } else if (left === "permission_classes" && (right.type === "list" || right.type === "tuple")) {
      data.permissionClasses = right.namedChildren.map((c) => c.text);
    }
  }
  if (Object.keys(data).length > 0) {
    facts.push({ kind: DJ_VIEW_CLASS, line: cls.startPosition.row + 1, owner: name, data });
  }
}

/** A dictionary's list of dotted class paths under `key`, as class names (`rest_framework.permissions.IsAuthenticated` → `IsAuthenticated`). */
function dictList(dict: Node, key: string): string[] | null {
  for (const pair of dict.namedChildren) {
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    const v = pair.childForFieldName("value");
    if (k?.type !== "string" || pyString(k.text) !== key || !v || (v.type !== "list" && v.type !== "tuple")) continue;
    return v.namedChildren.filter((c) => c.type === "string").map((c) => pyString(c.text).split(".").pop()!);
  }
  return null;
}

function positional(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
    (a) => a.type !== "keyword_argument" && a.type !== "comment",
  );
}

function keyword(call: Node, name: string): Node | null {
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === name) return a.childForFieldName("value");
  }
  return null;
}
