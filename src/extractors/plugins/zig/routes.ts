import type { Node, Tree } from "web-tree-sitter";
import type { RouteInfo } from "../../../types/analysis.js";
import type { RouteExtractor } from "../../routes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { callArgs, calleeName, declValue, isPub, memberName, stringValue } from "./syntax.js";

const VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", head: "HEAD", options: "OPTIONS" };

/** jetzig view functions → method + whether the path takes the resource id. */
const JETZIG_ACTIONS: Record<string, [string, boolean]> = {
  index: ["GET", false], get: ["GET", true], new: ["GET", false], edit: ["GET", true],
  post: ["POST", false], put: ["PUT", true], patch: ["PATCH", true], delete: ["DELETE", true],
};

/** `/users/:id` → `/users/{id}`. */
function zigPath(path: string): string {
  return path.replace(/:(\w+)/g, "{$1}");
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
}

/** Inside a `test "…" { … }` block: a fixture, not the app's routing. */
function inTest(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.type === "test_declaration") return true;
  return false;
}

/** A handler argument: `getUser`, `&handler`, `Handlers.list`. */
function handlerName(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "unary_expression") return handlerName(node.childForFieldName("argument") ?? node.namedChildren[0]);
  return calleeName(node);
}

/** `.name = value` entries of an anonymous struct initializer. */
function initFields(init: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  const list = init.namedChildren.find((c) => c.type === "initializer_list");
  for (const assign of list?.namedChildren ?? []) {
    if (assign.type !== "assignment_expression") continue;
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    const name = left?.type === "field_expression" ? left.childForFieldName("member")?.text : null;
    if (name && right) out.set(name, right);
  }
  return out;
}

/**
 * Zig web routes:
 *  - http.zig: `router.get("/users/:id", getUser, .{})`, under a group bound
 *    in the same function (`var admin = router.group("/admin", .{})`);
 *  - tokamak: `.get("/users", list)` decl literals, nested in `.group("/api", &.{ … })`;
 *  - zap: `router.handle_func("/x", &h, &H.get)` / `handle_func_unbound("/x", f)`,
 *    an endpoint initializer (`.{ .path = "/users", .get = getUser }`) and an
 *    endpoint struct (a `path` field defaulting to the URL, `pub fn get`/`post`/… methods);
 *  - jetzig: a view file `src/app/views/orders.zig` — `index` is `GET /orders`,
 *    `get` is `GET /orders/:id`, `post` is `POST /orders`, …
 */
export const zigRouteExtractor: RouteExtractor = {
  languages: ["zig"],
  extractRoutes(tree: Tree, sourceText: string, filePath?: string): RouteInfo[] {
    const routes: RouteInfo[] = [];
    const push = (at: Node, method: string | null, path: string, handler: string | null, body?: Node) =>
      routes.push({ path: zigPath(path), httpMethod: method, kind: "api", handler, calls: body ? extractCalls(body, "zig") : [], middleware: [], line: at.startPosition.row + 1 });

    const view = filePath ? /(?:^|\/)src\/app\/views\/(.+)\.zig$/.exec(filePath) : null;
    if (view) {
      const base = view[1] === "root" ? "/" : `/${view[1]!.replace(/\/root$/, "")}`;
      for (const fn of tree.rootNode.namedChildren.filter((c) => c.type === "function_declaration")) {
        const name = fn.childForFieldName("name")?.text ?? "";
        const action = JETZIG_ACTIONS[name];
        if (!action || !isPub(fn)) continue;
        const suffix = name === "new" ? "/new" : name === "edit" ? "/:id/edit" : action[1] ? "/:id" : "";
        push(fn, action[0], suffix ? joinPath(base, suffix) : base, name);
      }
      return routes;
    }
    if (!/\.(?:get|post|put|patch|delete|head|options|all|handle_func\w*)\s*\(|\.path\s*=|\bpath\s*:/.test(sourceText)) return [];

    // `var admin = router.group("/admin", .{})` → admin's prefix (within the file).
    const groups = new Map<string, string>();
    for (const decl of tree.rootNode.descendantsOfType("variable_declaration")) {
      const value = declValue(decl);
      const call = value?.type === "try_expression" ? value.namedChildren[0] : value;
      if (call?.type !== "call_expression" || memberName(call.childForFieldName("function")) !== "group") continue;
      const prefix = stringValue(callArgs(call)[0]);
      const owner = call.childForFieldName("function")?.childForFieldName("object");
      const name = decl.namedChildren[0]?.text;
      if (prefix !== null && name) groups.set(name, joinPath(owner?.type === "identifier" ? groups.get(owner.text) ?? "" : "", prefix));
    }
    // tokamak: the prefixes of the `.group("/api", …)` calls around a decl literal.
    const enclosingGroups = (node: Node): string => {
      let prefix = "";
      for (let p = node.parent; p; p = p.parent) {
        if (p.type === "call_expression" && memberName(p.childForFieldName("function")) === "group" && !p.childForFieldName("function")?.childForFieldName("object")) {
          prefix = joinPath(stringValue(callArgs(p)[0]) ?? "", prefix || "/");
        }
      }
      return prefix === "/" ? "" : prefix;
    };

    for (const call of tree.rootNode.descendantsOfType("call_expression")) {
      const callee = call.childForFieldName("function");
      const member = memberName(callee);
      if (!member || callee?.type !== "field_expression" || inTest(call)) continue;
      const args = callArgs(call);
      const path = stringValue(args[0]);
      if (path === null || !path.startsWith("/")) continue;
      const object = callee.childForFieldName("object");
      const verb = VERBS[member] ?? (member === "all" ? null : undefined);
      // http.zig's `router.get(path, action, .{…})` always passes its route
      // config; a two-argument `map.put("/x", handler)` is a hash map insert.
      const routerCall = !object || args.length >= 3 || (object.type === "identifier" && (/router/i.test(object.text) || groups.has(object.text)));
      if (verb !== undefined && routerCall) {
        const prefix = object ? (object.type === "identifier" ? groups.get(object.text) ?? "" : "") : enclosingGroups(call);
        push(call, verb, joinPath(prefix, path), handlerName(args[1]));
      } else if (/^handle_func(?:_unbound)?$/.test(member)) {
        push(call, null, path, handlerName(args[member === "handle_func" ? 2 : 1]));
      }
    }

    // zap endpoint initializer: `.{ .path = "/users", .get = getUser, .post = postUser }`.
    for (const init of tree.rootNode.descendantsOfType("anonymous_struct_initializer")) {
      const fields = initFields(init);
      const path = stringValue(fields.get("path"));
      if (path === null || !path.startsWith("/") || inTest(init)) continue;
      for (const [field, method] of Object.entries(VERBS)) {
        const handler = fields.get(field);
        if (handler) push(handler, method, path, handlerName(handler));
      }
    }

    // zap endpoint struct: `path: []const u8 = "/users"` with `pub fn get(self, r)` methods.
    for (const decl of tree.rootNode.descendantsOfType("variable_declaration")) {
      const value = declValue(decl);
      if (value?.type !== "struct_declaration") continue;
      const pathField = value.namedChildren.find((c) => c.type === "container_field" && c.childForFieldName("name")?.text === "path");
      const path = stringValue(pathField?.namedChildren[pathField.namedChildren.length - 1]);
      if (path === null || !path.startsWith("/")) continue;
      const name = decl.namedChildren[0]!.text;
      for (const fn of value.namedChildren.filter((c) => c.type === "function_declaration")) {
        const method = VERBS[fn.childForFieldName("name")?.text ?? ""];
        if (method) push(fn, method, path, `${name}.${fn.childForFieldName("name")!.text}`);
      }
    }
    return routes;
  },
};
