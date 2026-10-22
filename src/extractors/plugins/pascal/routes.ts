import type { Node } from "web-tree-sitter";
import type { RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { findChildByType } from "../../shared/node-helpers.js";
import { applyRouteMeta, pathParamNames } from "../../shared/route-metadata.js";
import type { RouteExtractor } from "../../routes/base.js";

/** Delphi DataSnap method prefixes that map to HTTP methods */
/** DataSnap REST: a server method's verb by its name prefix (the rest are GET), the prefix dropped from the path. */
const DELPHI_METHOD_PREFIXES: Record<string, string> = {
  accept: "PUT",
  update: "POST",
  cancel: "DELETE",
};

/**
 * The DataSnap server-method classes a unit declares: under `{$METHODINFO ON}`, or
 * deriving from `TDSServerModule`. Each public method is a REST endpoint.
 */
function dataSnapClasses(sourceText: string): Set<string> {
  const out = new Set<string>();
  for (const region of sourceText.matchAll(/\{\$METHODINFO\s+ON\}([\s\S]*?)(?:\{\$METHODINFO\s+OFF\}|\bimplementation\b)/gi)) {
    for (const m of region[1]!.matchAll(/\b(\w+)\s*=\s*class\b/gi)) out.add(m[1]!);
  }
  for (const m of sourceText.matchAll(/\b(\w+)\s*=\s*class\s*\(\s*TDSServerModule\w*\s*\)/gi)) out.add(m[1]!);
  return out;
}

/** The parameter names a routine declares (`(const Id: Integer; Name, Club: string)` → Id, Name, Club). */
function routineParams(declText: string): string[] {
  const list = /\(([^)]*)\)/.exec(declText)?.[1] ?? "";
  return list.split(";").flatMap((group) => {
    const names = group.split(":")[0]!.replace(/^\s*(?:const|var|out|constref)\s+/i, "");
    return names.split(",").map((n) => n.trim()).filter((n) => /^\w+$/.test(n));
  });
}

/** RAD Server (EMS) endpoint-method prefixes: `GetUsers`, `PostUser`, `PutItem`, `DeleteUser`. */
const RAD_SERVER_PREFIXES: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};

/** Objects RAD Server injects into an endpoint, never bound from the request. */
const RAD_SERVER_SERVICE_TYPES = new Set(["TEndpointContext", "TEndpointRequest", "TEndpointResponse"]);

/**
 * The method-name convention above only means anything inside a DataSnap /
 * RAD Server module — on an ordinary VCL form, `UpdateAll` is just a method.
 * Require framework evidence in the unit text before running the heuristic
 * (a desktop corpus otherwise sprouts a phantom `PUT /All` per Update* method).
 */
const DATASNAP_EVIDENCE_RE =
  /\b(Datasnap\.|DSServer|DSHTTP|DSProviderDataModuleAdapter|TDSServerModule|EMS\.|TEMSResource|EMSEndpoint|ResourceSuffix|ResourceName)\b/;

// ─── RAD Server attributes (interface section) ─────────────────────────────────
//
// `[ResourceName('users')]` sits on the class and `[ResourceSuffix('/{id}')]`
// / `[EndpointName('list')]` / `[EndpointMethod(TEndpointRequest.TMethod.Get)]`
// on the method declaration — all in the INTERFACE section, on `declType` /
// `declProc` nodes, not on the `defProc` implementation that carries the body.
// A first pass indexes them by class and method so the implementation walk
// can emit the declared route.

interface RadAttrs {
  resourceName?: string;
  resourceSuffix?: string;
  endpointName?: string;
  endpointMethod?: string;
}

interface RadClass {
  attrs: RadAttrs;
  methods: Map<string, RadAttrs>;
}

function stripPascalString(text: string): string {
  const t = text.trim();
  return t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
}

/** `[ResourceName('users'), EndpointMethod(TEndpointRequest.TMethod.Get)]` → the attrs it sets. */
function readAttrs(rtti: Node, into: RadAttrs): void {
  for (const child of rtti.children) {
    let name: string | null = null;
    let arg: string | null = null;
    if (child.type === "exprCall") {
      name = findChildByType(child, "identifier")?.text ?? null;
      const args = findChildByType(child, "exprArgs");
      arg = args?.children.find((a) => a.type !== "," && a.type !== "(" && a.type !== ")")?.text ?? null;
    } else if (child.type === "identifier") {
      name = child.text;
    }
    if (!name) continue;
    switch (name.toLowerCase()) {
      case "resourcename": if (arg) into.resourceName = stripPascalString(arg); break;
      case "resourcesuffix": if (arg) into.resourceSuffix = stripPascalString(arg); break;
      case "endpointname": if (arg) into.endpointName = stripPascalString(arg); break;
      case "endpointmethod":
        // `TEndpointRequest.TMethod.Put` → `Put`.
        if (arg) into.endpointMethod = arg.split(".").pop()!.trim();
        break;
    }
  }
}

function indexRadServerClasses(root: Node): Map<string, RadClass> {
  const out = new Map<string, RadClass>();
  const visit = (node: Node): void => {
    if (node.type === "declType") {
      const declClass = findChildByType(node, "declClass");
      const className = findChildByType(node, "identifier")?.text;
      if (declClass && className) {
        const cls: RadClass = { attrs: {}, methods: new Map() };
        const rtti = findChildByType(node, "rttiAttributes");
        if (rtti) readAttrs(rtti, cls.attrs);
        for (const section of declClass.children) {
          if (section.type !== "declSection") continue;
          for (const member of section.children) {
            if (member.type !== "declProc") continue;
            const methodRtti = findChildByType(member, "rttiAttributes");
            const methodName = findChildByType(member, "identifier")?.text;
            if (!methodRtti || !methodName) continue;
            const attrs: RadAttrs = {};
            readAttrs(methodRtti, attrs);
            if (Object.keys(attrs).length > 0) cls.methods.set(methodName.toLowerCase(), attrs);
          }
        }
        if (Object.keys(cls.attrs).length > 0 || cls.methods.size > 0) out.set(className, cls);
      }
      return; // nothing routable nests inside a type declaration
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

// ─── Endpoint parameters ───────────────────────────────────────────────────────

/** `(const AContext: TEndpointContext; const ARequest: TEndpointRequest)` → [{ name, type }]. */
function declaredParams(declProc: Node): Array<{ name: string; type: string | null }> {
  const out: Array<{ name: string; type: string | null }> = [];
  const args = findChildByType(declProc, "declArgs");
  if (!args) return out;
  for (const arg of args.children) {
    if (arg.type !== "declArg") continue;
    const type = findChildByType(arg, "type")?.text ?? null;
    for (const id of arg.children) if (id.type === "identifier") out.push({ name: id.text, type });
  }
  return out;
}

/** What the body reads from the request: `ARequest.Body.GetObject`, `ARequest.Params.Values['q']`. */
function bodyAccess(body: string, requestVar: string | null, path: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  if (!requestVar) return out;
  const tokens = pathParamNames(path);
  const seen = new Set<string>();
  const re = new RegExp(`\\b${requestVar}\\.(Body\\.(GetObject|GetStream|GetValue|GetArray|Get\\w*)|Params\\.Values\\[\\s*'([^']*)'\\s*\\])`, "gi");
  for (const m of body.matchAll(re)) {
    if (m[3] !== undefined) {
      const name = m[3];
      const binding = tokens.has(name.toLowerCase()) ? "route" : "query";
      if (binding === "route" || seen.has(`query:${name}`)) continue;
      seen.add(`query:${name}`);
      out.push({ name, type: null, binding, inferred: true });
      continue;
    }
    if (seen.has("body")) continue;
    seen.add("body");
    const getter = m[2]!.toLowerCase();
    const type = getter === "getobject" ? "TJSONObject" : getter === "getarray" ? "TJSONArray" : getter === "getstream" ? "TStream" : null;
    out.push({ name: "body", type, binding: "body", inferred: true });
  }
  return out;
}

function radServerParams(declProc: Node, bodyText: string, path: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  let requestVar: string | null = null;
  for (const p of declaredParams(declProc)) {
    if (p.type && RAD_SERVER_SERVICE_TYPES.has(p.type)) {
      if (p.type === "TEndpointRequest") requestVar = p.name;
      out.push({ name: p.name, type: p.type, binding: "services", inferred: true });
    } else {
      out.push({ name: p.name, type: p.type, binding: null });
    }
  }
  for (const m of path.matchAll(/\{([A-Za-z_]\w*)\}/g)) out.push({ name: m[1]!, type: null, binding: "route", inferred: true });
  out.push(...bodyAccess(bodyText, requestVar, path));
  return out;
}

/** RAD Server's verb for an endpoint: `[EndpointMethod]` first, else the method-name prefix. */
function radServerVerb(methodName: string, attrs: RadAttrs | undefined): string | null {
  if (attrs?.endpointMethod) return attrs.endpointMethod.toUpperCase();
  const lower = methodName.toLowerCase();
  for (const [prefix, verb] of Object.entries(RAD_SERVER_PREFIXES)) {
    if (lower.startsWith(prefix)) return verb;
  }
  return null;
}

// ─── Extraction ────────────────────────────────────────────────────────────────

/** Pascal / Delphi: DataSnap and RAD Server route patterns */
export function extractPascalRoutes(root: Node, routes: RouteInfo[], sourceText?: string): void {
  if (sourceText !== undefined && !DATASNAP_EVIDENCE_RE.test(sourceText)) return;
  const radClasses = indexRadServerClasses(root);
  const text = sourceText ?? root.text;
  walkForPascalRoutes(root, routes, radClasses, dataSnapClasses(text), /\bDatasnap\./i.test(text));
}

function walkForPascalRoutes(node: Node, routes: RouteInfo[], radClasses: Map<string, RadClass>, dataSnap: ReadonlySet<string>, dataSnapUnit: boolean) {
  if (node.type === "defProc") {
    const declProc = findChildByType(node, "declProc");
    if (!declProc) { recurse(node, routes, radClasses, dataSnap, dataSnapUnit); return; }

    let className = "";
    let methodName = "";
    for (const child of declProc.children) {
      if (child.type === "genericDot") {
        const parts: string[] = [];
        for (const part of child.children) {
          if (part.type === "identifier") parts.push(part.text);
        }
        if (parts.length >= 2) {
          className = parts[0];
          methodName = parts[parts.length - 1];
        }
      }
    }

    if (className && methodName) {
      const rad = radClasses.get(className);
      const methodAttrs = rad?.methods.get(methodName.toLowerCase());
      if (rad && (methodAttrs || rad.attrs.resourceName) && (methodAttrs || radServerVerb(methodName, undefined))) {
        // RAD Server endpoint: `/` + ResourceName + ResourceSuffix.
        const resource = (rad.attrs.resourceName ?? className.replace(/^T/, "")).replace(/^\/+|\/+$/g, "");
        const suffix = (methodAttrs?.resourceSuffix ?? "").replace(/^\/+|\/+$/g, "");
        const path = "/" + resource + (suffix ? `/${suffix}` : "");
        const route: RouteInfo = {
          path,
          httpMethod: radServerVerb(methodName, methodAttrs),
          kind: "api",
          handler: `${className}.${methodName}`,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        };
        applyRouteMeta(route, { params: radServerParams(declProc, node.text, path) });
        routes.push(route);
      } else if ((dataSnap.has(className) || dataSnapUnit) && !/^(?:create|destroy)$/i.test(methodName)) {
        // `/datasnap/rest/TServerMethods1/EchoString/{Value}`: the default REST root, the class, the
        // method (its verb prefix dropped), and a GET's or DELETE's parameters as path segments.
        // Outside a server-method class, only the DataSnap verb prefixes say a method is served.
        const lowerName = methodName.toLowerCase();
        const prefixed = Object.entries(DELPHI_METHOD_PREFIXES).find(([prefix]) => lowerName.startsWith(prefix) && lowerName.length > prefix.length);
        if (!prefixed && !dataSnap.has(className)) { recurse(node, routes, radClasses, dataSnap, dataSnapUnit); return; }
        const method = prefixed?.[1] ?? "GET";
        const name = prefixed ? methodName.slice(prefixed[0].length) : methodName;
        const params = method === "GET" || method === "DELETE" ? routineParams(declProc.text).map((p) => `/{${p}}`).join("") : "";
        routes.push({
          path: `/datasnap/rest/${className}/${name}${params}`,
          httpMethod: method,
          kind: "api",
          handler: `${className}.${methodName}`,
          calls: [],
          middleware: [],
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  recurse(node, routes, radClasses, dataSnap, dataSnapUnit);
}

function recurse(node: Node, routes: RouteInfo[], radClasses: Map<string, RadClass>, dataSnap: ReadonlySet<string>, dataSnapUnit: boolean) {
  for (const child of node.children) {
    walkForPascalRoutes(child, routes, radClasses, dataSnap, dataSnapUnit);
  }
}

/** Route-registry adapter for this plugin (see routes/base.ts). */
export const pascalRouteExtractor: RouteExtractor = {
  languages: ["pascal"],
  extractRoutes(tree, sourceText) {
    const routes: RouteInfo[] = [];
    extractPascalRoutes(tree.rootNode, routes, sourceText);
    return routes;
  },
};
