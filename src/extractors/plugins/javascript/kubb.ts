import { posix } from "node:path";
import type { Node, Tree } from "web-tree-sitter";
import type { FileAnalysis, FunctionInfo, GeneratedClientConfig, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { ProjectApiCall } from "../../data-sources/base.js";

/**
 * Kubb-generated API clients.
 *
 * Kubb (`kubb.config.ts`) reads an OpenAPI spec and writes one module per
 * operation into its output directory — `pluginClient` a request function
 * (`clients/getClub.ts` exporting `getClub`), the query plugins a hook
 * (`hooks/useGetClub.ts`). That directory is build output and usually
 * gitignored, so a call site states nothing HTTP:
 *
 *     import { getClub } from '@/api/clients/getClub'
 *     const club = await getClub(id)
 *
 * What the repository does state is the config — which spec, which output —
 * and the spec, which says `getClub` is `GET /league/clubs/{id}`. The config
 * is read per file (`extractKubbConfigs` → `FileAnalysis.generatedClients`);
 * the project pass (`resolveKubbClientCalls`) turns each call of an import
 * from that output into an api-call at the operation's method and path, which
 * the route linker joins to the spec's row and through it to the code route
 * implementing it. When the generated modules ARE on disk, the import
 * resolves to them and their own requests are the api-calls: nothing is added.
 */

const CONFIG_FILE = /(?:^|\/)kubb\.config\.[cm]?[jt]s$/;

/** Kubb plugins that write one module per operation, with their default output directory. */
const OUTPUT_PLUGINS: Record<string, { kind: "client" | "hook"; dir: string }> = {
  pluginClient: { kind: "client", dir: "clients" },
  pluginReactQuery: { kind: "hook", dir: "hooks" },
  pluginVueQuery: { kind: "hook", dir: "hooks" },
  pluginSvelteQuery: { kind: "hook", dir: "hooks" },
  pluginSolidQuery: { kind: "hook", dir: "hooks" },
  pluginSwr: { kind: "hook", dir: "hooks" },
};

function keyOf(pair: Node): string | null {
  const key = pair.childForFieldName("key");
  if (!key) return null;
  if (key.type === "string") return key.text.slice(1, -1);
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
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

function stringOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string") return node.text.slice(1, -1);
  if (node.type === "template_string" && !node.namedChildren.some((c) => c?.type === "template_substitution")) return node.text.slice(1, -1);
  return null;
}

/** `x: 'dir'` or `x: { path: 'dir' }` — Kubb has spelled both. */
function pathOf(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "object") return stringOf(pairsOf(node).get("path"));
  return stringOf(node);
}

function joinPath(...parts: string[]): string {
  return posix.normalize(posix.join(...parts)).replace(/\/+$/, "").replace(/^\.\/?$/, "");
}

/** Every config object in a `kubb.config.ts`: an object literal stating both `input` and `output`. */
export function extractKubbConfigs(tree: Tree, sourceText: string, filePath: string): GeneratedClientConfig[] {
  if (!CONFIG_FILE.test(filePath) || !sourceText.includes("input")) return [];
  const configDir = posix.dirname(filePath) === "." ? "" : posix.dirname(filePath);
  const out: GeneratedClientConfig[] = [];
  const visit = (n: Node) => {
    if (n.type === "object") {
      const pairs = pairsOf(n);
      const input = pathOf(pairs.get("input"));
      const output = pathOf(pairs.get("output"));
      if (input && output && !/^[a-z]+:\/\//i.test(input)) {
        const base = joinPath(configDir, stringOf(pairs.get("root")) ?? ".");
        const root = joinPath(base, output);
        const outputs: GeneratedClientConfig["outputs"] = [];
        const plugins = pairs.get("plugins");
        for (const p of plugins?.type === "array" ? plugins.namedChildren : []) {
          if (p?.type !== "call_expression") continue;
          const known = OUTPUT_PLUGINS[p.childForFieldName("function")?.text ?? ""];
          if (!known) continue;
          const options = p.childForFieldName("arguments")?.namedChildren[0];
          const dir = (options?.type === "object" ? pathOf(pairsOf(options).get("output")) : null) ?? known.dir;
          outputs.push({ dir: joinPath(root, dir), kind: known.kind });
        }
        if (outputs.length > 0) {
          out.push({ generator: "kubb", spec: joinPath(base, input), root, outputs, line: n.startPosition.row + 1 });
        }
        return;
      }
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

/**
 * The spelling-free key of a generated name. Kubb camel-cases an operationId
 * into its function and file name (`getClub_1` → `getClub1`, `get-club` →
 * `getClub`, `getHTTPStatus` → `getHttpStatus`); case and separators are all
 * it changes.
 */
function nameKey(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/** Generated name key → the spec route it requests; a key two operations share is dropped. */
function namesFor(routes: readonly RouteInfo[], kind: "client" | "hook"): Map<string, RouteInfo> {
  const out = new Map<string, RouteInfo | null>();
  for (const r of routes) {
    if (!r.handler || !r.httpMethod) continue;
    const key = nameKey(kind === "hook" ? `use${r.handler}` : r.handler);
    out.set(key, out.has(key) ? null : r);
  }
  return new Map([...out].filter((e): e is [string, RouteInfo] => e[1] !== null));
}

interface Output {
  dir: string;
  names: Map<string, RouteInfo>;
  /** The output root: only a barrel import of it names operations, never a module under it. */
  barrel: boolean;
}

const MODULE_EXT = /\.(?:[cm]?[jt]sx?|vue)$/;

/** An import source as the project path it names (extension and `/index` dropped). */
function moduleOf(importer: string, source: string): string {
  const raw = source.startsWith(".") ? joinPath(posix.dirname(importer), source) : source.replace(/\/+$/, "");
  return raw.replace(MODULE_EXT, "").replace(/\/index$/, "");
}

/**
 * Project pass: each call of a function imported from a Kubb output becomes
 * an api-call at the method and path the spec gives its operation (`endpoint`
 * is the operationId). Appends to `calls`; returns how many it added.
 */
export function resolveKubbClientCalls(calls: ProjectApiCall[], analyses: readonly FileAnalysis[], ctx: ProjectContext): number {
  const outputs: Output[] = [];
  for (const a of analyses) {
    for (const cfg of a.generatedClients ?? []) {
      if (cfg.generator !== "kubb") continue;
      const routes = ctx.fileOf(cfg.spec)?.routes ?? [];
      if (routes.length === 0) continue;
      const byKind = { client: namesFor(routes, "client"), hook: namesFor(routes, "hook") };
      for (const o of cfg.outputs) outputs.push({ dir: o.dir, names: byKind[o.kind], barrel: false });
      outputs.push({ dir: cfg.root, names: new Map([...byKind.client, ...byKind.hook]), barrel: true });
    }
  }
  if (outputs.length === 0) return 0;
  // Longest directory first, so `api/clients/x` is the clients output's, not the root's.
  outputs.sort((x, y) => y.dir.length - x.dir.length);

  let added = 0;
  for (const a of analyses) {
    if (a.imports.length === 0) continue;
    const own = new Set(a.functions.map((f) => f.name));
    const bound = new Map<string, RouteInfo>();
    const namespaces = new Map<string, Map<string, RouteInfo>>();
    for (const imp of a.imports) {
      if (imp.isType || imp.specifiers.length === 0) continue;
      const mod = moduleOf(a.filePath, imp.source);
      const out = outputs.find((o) => mod === o.dir || (!o.barrel && mod.startsWith(`${o.dir}/`)));
      if (!out) continue;
      // Generated code that is on disk is analyzed: its own requests are the api-calls.
      if (ctx.resolveModule(a.filePath, imp.source)) continue;
      if (imp.isNamespace) {
        if (mod === out.dir) namespaces.set(imp.specifiers[0]!, out.names);
        continue;
      }
      // A module per operation answers by its file name; a barrel by each name imported.
      const single = mod === out.dir ? null : out.names.get(nameKey(posix.basename(mod)));
      if (mod !== out.dir && !single) continue;
      const specs = imp.specifiers;
      for (let i = 0; i < specs.length; i++) {
        const route = single && (imp.isDefault && i === 0) ? single : routeNamed(out.names, specs[i]!, single);
        if (!route) continue;
        bind(bound, own, specs[i]!, route);
        // `{ getClub as fetchClub }` is stored as [fetchClub, getClub]: the alias precedes the name it binds.
        const prev = i > 0 ? specs[i - 1]! : null;
        if (prev && !(imp.isDefault && i === 1) && !routeNamed(out.names, prev, single)) bind(bound, own, prev, route);
      }
    }
    if (bound.size === 0 && namespaces.size === 0) continue;

    const seen = new Set<string>();
    const emit = (fn: FunctionInfo) => {
      for (const call of fn.calls) {
        let route = bound.get(call.name);
        if (!route && namespaces.size > 0) {
          const dot = call.name.indexOf(".");
          if (dot > 0 && call.name.indexOf(".", dot + 1) < 0) {
            route = namespaces.get(call.name.slice(0, dot))?.get(nameKey(call.name.slice(dot + 1)));
          }
        }
        if (!route) continue;
        const key = `${call.line}:${call.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({
          kind: "api-call",
          name: route.httpMethod!.toLowerCase(),
          target: route.path,
          line: call.line,
          calls: [],
          endpoint: route.handler!,
          filePath: a.filePath,
        });
        added++;
      }
    };
    for (const fn of a.functions) emit(fn);
    for (const cls of a.classes) for (const m of cls.methods) emit(m);
  }
  return added;
}

/** The operation an imported name calls: in a per-operation module only that module's own function. */
function routeNamed(names: ReadonlyMap<string, RouteInfo>, spec: string, single: RouteInfo | null | undefined): RouteInfo | null {
  const route = names.get(nameKey(spec)) ?? null;
  return single ? (route === single ? route : null) : route;
}

function bind(bound: Map<string, RouteInfo>, own: ReadonlySet<string>, local: string, route: RouteInfo): void {
  // A function the file declares itself shadows the import of the same name.
  if (!own.has(local)) bound.set(local, route);
}
