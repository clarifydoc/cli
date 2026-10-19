import type { RouteAuthInfo, RouteInfo } from "../../../types/analysis.js";
import { parseOpenApiDocument, type SpecNode } from "../openapi/index.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Serverless routes, read from the deployment descriptor that declares them:
 *
 *   # serverless.yml (Serverless Framework)
 *   functions:
 *     listUsers:
 *       handler: src/handlers/users.list      → GET /users, handler "src/handlers/users.list"
 *       events:
 *         - http: { path: users, method: get, authorizer: auth }
 *         - httpApi: 'POST /users'
 *
 *   # template.yaml (AWS SAM)
 *   Resources:
 *     HelloFunction:
 *       Type: AWS::Serverless::Function
 *       Properties: { CodeUri: hello_world/, Handler: app.lambda_handler }
 *       Events:
 *         Hello: { Type: Api, Properties: { Path: /hello, Method: get } }
 *                                              → GET /hello, handler "hello_world/app.lambda_handler"
 *
 * A route's `handler` is the module path and export as the descriptor names
 * them, relative to the descriptor's directory (a SAM `CodeUri` joined in
 * front; a JVM / .NET `Class::method` kept as written), and `owner` is the
 * function's name in the descriptor. The project pass (`route-anchor.ts`)
 * moves each row onto the function it names. Non-HTTP events (queues,
 * schedules) are not routes.
 */

const ANY = new Set(["any", "*"]);

const childOf = (n: SpecNode | undefined, key: string): SpecNode | undefined => n?.children.get(key);
const valueOf = (n: SpecNode | undefined, key: string): string | null => childOf(n, key)?.value ?? null;

function normalizePath(path: string): string {
  const p = path.trim().replace(/^["']|["']$/g, "");
  return p.startsWith("/") ? p : `/${p}`;
}

function methodOf(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().toLowerCase();
  return ANY.has(m) ? null : m.toUpperCase();
}

function authOf(scheme: string): RouteAuthInfo {
  return { policies: [], roles: [], schemes: [scheme], anonymous: false, inherited: false };
}

function route(path: string, method: string | null, handler: string | null, owner: string, line: number, auth?: string): RouteInfo {
  return {
    path: normalizePath(path),
    httpMethod: method,
    kind: "api",
    handler,
    calls: [],
    middleware: auth ? [`authorizer:${auth}`] : [],
    line,
    owner,
    ...(auth ? { auth: authOf(auth) } : {}),
  };
}

/** `authorizer: name`, `authorizer: { name: x }`, `authorizer: aws_iam`, `private: true` (an API key). */
function slsAuthorizer(ev: SpecNode | undefined): string | undefined {
  const a = childOf(ev, "authorizer");
  const name = a?.value ?? valueOf(a, "name") ?? valueOf(a, "type") ?? (a?.children.has("arn") ? "arn" : null);
  if (name) return name;
  if (valueOf(ev, "private") === "true") return "api-key";
  return undefined;
}

function serverlessRoutes(root: SpecNode): RouteInfo[] {
  const out: RouteInfo[] = [];
  const functions = childOf(root, "functions");
  if (!functions) return out;
  for (const [name, fn] of functions.children) {
    const handler = valueOf(fn, "handler");
    for (const item of childOf(fn, "events")?.items ?? []) {
      for (const kind of ["http", "httpApi"] as const) {
        const ev = childOf(item, kind);
        if (!ev) continue;
        if (ev.value) {
          // Short forms: `http: GET users/{id}`, `httpApi: 'POST /users'`, `httpApi: '*'`.
          const m = /^\s*([A-Za-z*]+)\s+(\S+)\s*$/.exec(ev.value.replace(/^["']|["']$/g, ""));
          if (m) out.push(route(m[2]!, methodOf(m[1]!), handler, name, ev.line));
          continue;
        }
        const path = valueOf(ev, "path");
        if (!path) continue;
        out.push(route(path, methodOf(valueOf(ev, "method")), handler, name, ev.line, slsAuthorizer(ev)));
      }
    }
  }
  return out;
}

const join = (dir: string | null, file: string): string => {
  const d = (dir ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  return d && d !== "." ? `${d}/${file}` : file;
};

function samRoutes(root: SpecNode): RouteInfo[] {
  const out: RouteInfo[] = [];
  const globals = childOf(childOf(root, "Globals"), "Function");
  const defaultAuth = valueOf(childOf(childOf(childOf(root, "Globals"), "Api"), "Auth"), "DefaultAuthorizer") ?? undefined;
  for (const [name, res] of childOf(root, "Resources")?.children ?? []) {
    if (valueOf(res, "Type") !== "AWS::Serverless::Function") continue;
    const props = childOf(res, "Properties");
    const handler = valueOf(props, "Handler") ?? valueOf(globals, "Handler");
    const codeUri = valueOf(props, "CodeUri") ?? valueOf(globals, "CodeUri");
    // A JVM / .NET handler names a class (`helloworld.App::handleRequest`); a script one, a file in CodeUri.
    const written = handler ? (handler.includes("::") ? handler : join(codeUri, handler)) : null;
    for (const [, ev] of childOf(props, "Events")?.children ?? []) {
      const type = valueOf(ev, "Type");
      if (type !== "Api" && type !== "HttpApi") continue;
      const p = childOf(ev, "Properties");
      const path = valueOf(p, "Path");
      if (!path) continue;
      const auth = valueOf(childOf(p, "Auth"), "Authorizer") ?? defaultAuth;
      out.push(route(path, methodOf(valueOf(p, "Method")), written, name, ev.line, auth && auth !== "NONE" ? auth : undefined));
    }
  }
  return out;
}

export function extractServerlessRoutes(lines: string[]): RouteInfo[] {
  const root = parseOpenApiDocument(lines);
  return root.children.has("Resources") ? samRoutes(root) : serverlessRoutes(root);
}

export const serverlessSpec: RegexLangSpec = {
  language: "serverless",
  extensions: [],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["#"],
  extractRoutes: (lines) => extractServerlessRoutes(lines),
};
