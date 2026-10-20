import type { Node } from "web-tree-sitter";
import type { FileAnalysis, RouteFact, RouteInfo } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { joinRelPath, lambdaModuleHandler } from "../../shared/lambda-handlers.js";

/**
 * AWS CDK stacks: the API Gateway routes they wire to Lambda functions.
 *
 *   const list = new lambda.Function(this, "List", { handler: "users.list", code: lambda.Code.fromAsset("lambda") });
 *   const get = new NodejsFunction(this, "Get", { entry: path.join(__dirname, "../src/get.ts") });
 *   const api = new apigw.RestApi(this, "Api");
 *   const users = api.root.addResource("users");
 *   users.addMethod("GET", new apigw.LambdaIntegration(list));          → GET /users  → lambda/users.ts list
 *   users.addResource("{id}").addMethod("GET", new LambdaIntegration(get)); → GET /users/{id} → src/get.ts handler
 *   httpApi.addRoutes({ path: "/items", methods: [HttpMethod.POST], integration: new HttpLambdaIntegration("I", list) });
 *
 * Read per file as `cdk:route` facts — the method, the resource path, and the
 * Lambda's handler as a module spec with the directory it is relative to: the
 * stack file's (`path.join(__dirname, …)`) or the CDK app's working directory
 * (a plain string, tried from the stack's directory up). The project pass
 * puts each route on the function the handler names (the shared Lambda
 * handler lookup); one it cannot place stays on the stack file. A
 * `LambdaRestApi` proxies every request: `ANY /{proxy+}`.
 */

export const CDK_ROUTE = "cdk:route";

interface LambdaSpec {
  /** The directory the handler module is in, relative to `base`. */
  dir: string;
  base: "file" | "cwd";
  /** `module.export`, as the Lambda runtime reads `handler`. */
  spec: string;
}

export interface CdkRouteFact {
  method: string | null;
  path: string;
  lambda: LambdaSpec | null;
}

const FUNCTION_CTOR = /(?:^|\.)(Function|NodejsFunction|PythonFunction|SingletonFunction)$/;
const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const propOf = (obj: Node | null | undefined, key: string): Node | null => {
  for (const p of obj?.namedChildren ?? []) {
    if (p.type === "pair" && p.childForFieldName("key")?.text === key) return p.childForFieldName("value");
    if (p.type === "shorthand_property_identifier" && p.text === key) return p;
  }
  return null;
};
const args = (call: Node): Node[] => call.childForFieldName("arguments")?.namedChildren ?? [];
const str = (n: Node | null | undefined): string | null => (n && (n.type === "string" || (n.type === "template_string" && !n.text.includes("${"))) ? stripQuotes(n.text) : null);

/** A path expression: a literal (the app's working directory), or `path.join(__dirname, …)` / `` `${__dirname}/…` `` (the file's). */
function pathOf(n: Node | null): { rel: string; base: "file" | "cwd" } | null {
  if (!n) return null;
  const lit = str(n);
  if (lit !== null) return { rel: lit, base: "cwd" };
  if (n.type === "template_string") {
    const m = /^`\$\{__dirname\}\/?([^`$]*)`$/.exec(n.text);
    return m ? { rel: m[1]!, base: "file" } : null;
  }
  if (n.type === "call_expression" && /^(?:path\.)?(?:join|resolve)$/.test(n.childForFieldName("function")?.text ?? "")) {
    const [first, ...rest] = args(n);
    if (first?.text !== "__dirname") return null;
    const parts = rest.map(str);
    return parts.every((p): p is string => p !== null) ? { rel: parts.join("/"), base: "file" } : null;
  }
  return null;
}

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** The handler a Lambda construct's props name. */
function lambdaOf(ctor: string, props: Node | null): LambdaSpec | null {
  if (ctor === "NodejsFunction") {
    const entry = pathOf(propOf(props, "entry"));
    if (!entry) return null;
    const handler = str(propOf(props, "handler")) ?? "handler";
    return { dir: dirname(entry.rel), base: entry.base, spec: `${basename(entry.rel).replace(/\.[cm]?[jt]sx?$/, "")}.${handler}` };
  }
  if (ctor === "PythonFunction") {
    const entry = pathOf(propOf(props, "entry"));
    if (!entry) return null;
    const index = (str(propOf(props, "index")) ?? "index.py").replace(/\.py$/, "");
    return { dir: entry.rel, base: entry.base, spec: `${index}.${str(propOf(props, "handler")) ?? "handler"}` };
  }
  const handler = str(propOf(props, "handler"));
  const code = propOf(props, "code");
  const asset = code?.type === "call_expression" && /(?:^|\.)Code\.fromAsset$/.test(code.childForFieldName("function")?.text ?? "") ? pathOf(args(code)[0] ?? null) : null;
  return handler && asset ? { dir: asset.rel, base: asset.base, spec: handler } : null;
}

export function collectCdkRoutes(root: Node, sourceText: string, facts: RouteFact[] | undefined): void {
  if (!facts || !/aws-cdk-lib|@aws-cdk\//.test(sourceText)) return;
  const lambdas = new Map<string, LambdaSpec | null>();
  const integrations = new Map<string, string>();
  const resources = new Map<string, string>();
  const apis = new Set<string>();

  const integrationTarget = (n: Node | null | undefined): string | null => {
    if (!n) return null;
    if (n.type === "identifier") return integrations.get(n.text) ?? null;
    if (n.type !== "new_expression" || !/LambdaIntegration$/.test(n.childForFieldName("constructor")?.text ?? "")) return null;
    // `new LambdaIntegration(fn)`; `new HttpLambdaIntegration("Id", fn)`.
    const fn = args(n).find((a) => a.type === "identifier");
    return fn ? fn.text : null;
  };
  /** The resource path an expression stands for: `api.root`, `x.addResource("seg")`, a resource variable. */
  const resourcePath = (n: Node | null | undefined): string | null => {
    if (!n) return null;
    if (n.type === "identifier") return resources.get(n.text) ?? null;
    if (n.type === "member_expression" && n.childForFieldName("property")?.text === "root" && apis.has(n.childForFieldName("object")?.text ?? "")) return "";
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const method = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : undefined;
      const seg = str(args(n)[0]);
      const parent = fn?.type === "member_expression" ? resourcePath(fn.childForFieldName("object")) : null;
      if (parent !== null && seg !== null && (method === "addResource" || method === "resourceForPath")) return `${parent}/${seg.replace(/^\/+|\/+$/g, "")}`;
    }
    return null;
  };
  const push = (line: number, method: string | null, path: string, fnVar: string | null) => {
    facts.push({ kind: CDK_ROUTE, line, data: { method, path: path || "/", lambda: fnVar ? lambdas.get(fnVar) ?? null : null } satisfies CdkRouteFact });
  };

  const visit = (n: Node): void => {
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name")?.text;
      const value = n.childForFieldName("value");
      if (name && value?.type === "new_expression") {
        const ctor = value.childForFieldName("constructor")?.text ?? "";
        const props = args(value)[2] ?? null;
        const fnCtor = FUNCTION_CTOR.exec(ctor);
        if (fnCtor) lambdas.set(name, lambdaOf(fnCtor[1]!, props));
        else if (/LambdaIntegration$/.test(ctor)) {
          const target = integrationTarget(value);
          if (target) integrations.set(name, target);
        } else if (/(?:^|\.)(?:RestApi|LambdaRestApi|SpecRestApi|HttpApi)$/.test(ctor)) {
          apis.add(name);
          if (/LambdaRestApi$/.test(ctor) && propOf(props, "proxy")?.text !== "false") {
            const handler = propOf(props, "handler");
            if (handler?.type === "identifier") push(n.startPosition.row + 1, null, "/{proxy+}", handler.text);
          }
        }
      } else if (name && value) {
        const path = resourcePath(value);
        if (path !== null) resources.set(name, path);
      }
    }
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const method = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : undefined;
      if (method === "addMethod") {
        const path = resourcePath(fn!.childForFieldName("object"));
        const verb = str(args(n)[0])?.toUpperCase();
        const target = integrationTarget(args(n)[1]);
        if (path !== null && verb) push(n.startPosition.row + 1, verb === "ANY" ? null : verb, path, target);
      } else if (method === "addRoutes" && apis.has(fn!.childForFieldName("object")?.text ?? "")) {
        const opts = args(n)[0];
        const path = str(propOf(opts, "path"));
        const target = integrationTarget(propOf(opts, "integration"));
        const methods = (propOf(opts, "methods")?.namedChildren ?? []).map((m) => m.text.split(".").pop()!.toUpperCase()).filter((m) => VERBS.has(m) || m === "ANY");
        if (path !== null) for (const m of methods.length ? methods : ["ANY"]) push(n.startPosition.row + 1, m === "ANY" ? null : m, path, target);
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
}

/**
 * CDK routes on the functions their Lambdas run: the handler module under the
 * asset directory — relative to the stack file, or to the app's working
 * directory, tried from the stack's directory up — else on the stack file.
 */
export const cdkRouteResolver: RouteResolver = {
  id: "cdk-routes",
  languages: ["typescript", "javascript", "python", "ruby", "java", "kotlin", "csharp"],
  priority: 50,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== CDK_ROUTE) continue;
        const { method, path, lambda } = f.data as CdkRouteFact;
        const stackDir = dirname(a.filePath);
        let hit = null;
        if (lambda) {
          const bases = lambda.base === "file" ? [stackDir] : ancestors(stackDir);
          for (const base of bases) {
            hit = lambdaModuleHandler(lambda.spec, joinRelPath(base, lambda.dir), ctx);
            if (hit) break;
          }
        }
        const row: RouteInfo = hit
          ? { path, httpMethod: method, kind: "api", handler: hit.handler, calls: hit.fn.calls, middleware: [], line: hit.fn.line }
          : { path, httpMethod: method, kind: "api", handler: lambda ? `${lambda.dir ? `${lambda.dir}/` : ""}${lambda.spec}` : null, calls: [], middleware: [], line: f.line };
        const target = hit ? hit.file : a;
        target.routes = [...target.routes, row];
      }
    }
  },
};

/** `a/b/c` → `a/b/c`, `a/b`, `a`, `` — where a working directory may be. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (!d) return out;
    d = dirname(d);
  }
}
