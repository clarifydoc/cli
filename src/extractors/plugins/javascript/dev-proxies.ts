import type { Node, Tree } from "web-tree-sitter";
import type { ProxyRule } from "../../../types/analysis.js";
import { jsBaseRefOf } from "./service-config.js";
import { isHttpTarget, prefixOfPattern, rewritePrefix } from "../shared/proxy-kit.js";

/**
 * Dev-server proxies a frontend declares in code:
 *   vite.config.ts      server: { proxy: { "/api": { target, rewrite } } }
 *   webpack/vue config  devServer: { proxy: { "/api": { target, pathRewrite } } }
 *                       devServer: { proxy: [{ context: ["/api"], target }] }
 *   src/setupProxy.js   app.use("/api", createProxyMiddleware({ target }))
 * In development the frontend's same-origin `/api/...` calls go wherever
 * these say; that is the stated link from a frontend to its backend.
 */
const CONFIG_FILE = /(?:^|\/)(?:(vite|vitest|vue|nuxt|webpack[\w.-]*)\.config|setupProxy)\.[cm]?[jt]s$/;

function keyOf(pair: Node): string | null {
  const key = pair.childForFieldName("key");
  if (!key) return null;
  if (key.type === "string") return key.text.slice(1, -1);
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  return null;
}

function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return node.text.slice(1, -1);
  if (node.type === "template_string" && !node.namedChildren.some((c) => c?.type === "template_substitution")) return node.text.slice(1, -1);
  return null;
}

function pairsOf(obj: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const p of obj.namedChildren) {
    if (p?.type !== "pair") continue;
    const k = keyOf(p);
    const v = p.childForFieldName("value");
    if (k && v) out.set(k, v);
  }
  return out;
}

/** A target as stated: a literal address, or an env variable's literal fallback. */
function targetOf(node: Node | undefined): string | null {
  if (!node) return null;
  const ref = jsBaseRefOf(node.text);
  const t = ref?.kind === "literal" ? ref.key : ref?.fallback ?? null;
  return t && isHttpTarget(t) ? t : null;
}

/**
 * The target a local helper's returned options state for one call
 * (`function serviceProxy(service, port, target = env.X) { return { target: target || \`http://localhost:${port}\` } }`
 * called as `serviceProxy("clubs", 8084)` → `http://localhost:8084`): its parameters filled with
 * the call's literal arguments; a runtime value `||`-ed with a literal states the literal.
 */
function helperTarget(call: Node, root: Node): string | null {
  const name = call.childForFieldName("function")?.text;
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const fn = root.descendantsOfType("function_declaration").find((f) => f?.childForFieldName("name")?.text === name);
  const body = fn?.childForFieldName("body");
  const ret = body?.namedChildren.find((c) => c?.type === "return_statement")?.namedChildren[0];
  if (!fn || ret?.type !== "object") return null;
  const target = pairsOf(ret).get("target");
  if (!target) return null;
  const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
  const params = (fn.childForFieldName("parameters")?.namedChildren ?? []).filter((p): p is Node => !!p);
  const values = new Map<string, string>();
  params.forEach((p, i) => {
    const id = p.type === "identifier" ? p : p.childForFieldName("pattern") ?? p.childForFieldName("left") ?? p.namedChildren.find((c) => c?.type === "identifier");
    const arg = args[i];
    const lit = arg ? (arg.type === "number" ? arg.text : stringValue(arg)) : null;
    if (id && lit !== null) values.set(id.text, lit);
  });
  // Fill `${port}` holes and bare parameter names with the call's literals.
  let text = target.text.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (m, p: string) => values.get(p) ?? m);
  const or = /^([\s\S]+?)\s*(?:\|\||\?\?)\s*([\s\S]+)$/.exec(text);
  if (or && !values.has(or[1]!.trim())) text = or[2]!;
  else if (values.has(text.trim())) text = JSON.stringify(values.get(text.trim()));
  if (/\$\{/.test(text)) return null;
  const ref = jsBaseRefOf(text);
  const t = ref?.kind === "literal" ? ref.key : ref?.fallback ?? null;
  return t && isHttpTarget(t) ? t : null;
}

/** `rewrite: (p) => p.replace(/^\/api/, "")` or `pathRewrite: { "^/api": "" }`, applied to `prefix`. */
function rewriteOf(options: Map<string, Node>, prefix: string): string | undefined {
  const fn = options.get("rewrite");
  if (fn) {
    const m = /\.replace\(\s*\/((?:[^/\\]|\\.)+)\/[a-z]*\s*,\s*(['"`])([^'"`]*)\2\s*\)/.exec(fn.text);
    if (m) return rewritePrefix(prefix, m[1]!, m[3]!);
  }
  const map = options.get("pathRewrite");
  if (map?.type === "object") {
    for (const [pattern, value] of pairsOf(map)) {
      const to = stringValue(value);
      if (to !== null) {
        const r = rewritePrefix(prefix, pattern, to);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

export function extractDevProxyRules(tree: Tree, sourceText: string, filePath: string): ProxyRule[] {
  const m = CONFIG_FILE.exec(filePath);
  if (!m || !/proxy/i.test(sourceText)) return [];
  const via = m[1]?.startsWith("vite") || m[1] === "vitest" ? "vite" : m[1] === undefined ? "cra" : "webpack";
  const out: ProxyRule[] = [];
  const push = (prefixPattern: string, target: string | null, options: Map<string, Node>, at: Node) => {
    const pathPrefix = prefixOfPattern(prefixPattern);
    if (pathPrefix === null || !target) return;
    const rewriteTo = rewriteOf(options, pathPrefix);
    out.push({ pathPrefix, target, ...(rewriteTo !== undefined ? { rewriteTo } : {}), via, file: filePath, line: at.startPosition.row + 1 });
  };

  for (const pair of tree.rootNode.descendantsOfType("pair")) {
    if (!pair || keyOf(pair) !== "proxy") continue;
    const value = pair.childForFieldName("value");
    if (value?.type === "object") {
      // { "/api": "http://…" } or { "/api": { target, rewrite } }
      for (const p of value.namedChildren) {
        if (p?.type !== "pair") continue;
        const key = keyOf(p);
        const v = p.childForFieldName("value");
        if (!key || !v) continue;
        if (v.type === "object") {
          const opts = pairsOf(v);
          push(key, targetOf(opts.get("target")), opts, p);
        } else if (v.type === "call_expression") {
          // `"/clubs/": serviceProxy("clubs", 8084)`: a helper of the file returning the options.
          push(key, helperTarget(v, tree.rootNode), new Map(), p);
        } else push(key, targetOf(v), new Map(), p);
      }
    } else if (value?.type === "array") {
      // [{ context: ["/api", "/auth"], target }]
      for (const el of value.namedChildren) {
        if (el?.type !== "object") continue;
        const opts = pairsOf(el);
        const ctx = opts.get("context");
        const contexts = ctx?.type === "array" ? ctx.namedChildren.map((c) => stringValue(c)) : [stringValue(ctx)];
        for (const c of contexts) if (c) push(c, targetOf(opts.get("target")), opts, el);
      }
    }
  }

  // http-proxy-middleware: app.use("/api", createProxyMiddleware({ target })),
  // or the options carrying the path (`pathFilter`, `context`).
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call || !/^(?:createProxyMiddleware|proxy)$/.test(call.childForFieldName("function")?.text ?? "")) continue;
    const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a) ?? [];
    const optsNode = args.find((a) => a.type === "object");
    if (!optsNode) continue;
    const opts = pairsOf(optsNode);
    let prefix = stringValue(args[0]) ?? stringValue(opts.get("pathFilter")) ?? stringValue(opts.get("context"));
    if (prefix === null) {
      const use = call.parent?.parent;
      if (use?.type === "call_expression" && /\.use$/.test(use.childForFieldName("function")?.text ?? "")) {
        prefix = stringValue(use.childForFieldName("arguments")?.namedChildren[0]);
      }
    }
    if (prefix !== null) push(prefix, targetOf(opts.get("target")), opts, call);
  }
  return out;
}
