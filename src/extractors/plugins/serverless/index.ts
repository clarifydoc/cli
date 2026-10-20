import type { EntryPointInfo, RouteAuthInfo, RouteInfo } from "../../../types/analysis.js";
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
 * moves each row onto the function it names. Non-HTTP events are not routes:
 * a schedule makes the function a scheduled job, a queue, topic or stream a
 * message consumer (`extractServerlessEntryPoints`), moved onto it the same way.
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

/**
 * The resource an event names, readably: `arn:aws:sqs:eu-west-1:123:orders` → `orders`,
 * `!GetAtt OrdersQueue.Arn` / `{ Fn::GetAtt: [OrdersQueue, Arn] }` → `OrdersQueue`, `${self:custom.queue}` kept.
 */
function resourceName(n: SpecNode | undefined): string | null {
  if (!n) return null;
  // `Fn::GetAtt: [OrdersQueue, Arn]`, as a block list or a flow one, under the event or its `arn:`.
  const getAtt = childOf(n, "Fn::GetAtt") ?? childOf(childOf(n, "arn"), "Fn::GetAtt");
  const attTarget = getAtt?.items?.[0]?.value ?? /^\[\s*([\w-]+)/.exec(getAtt?.value ?? "")?.[1] ?? (getAtt?.value ? getAtt.value.split(".")[0] : undefined);
  if (attTarget) return attTarget;
  const raw = n.value ?? valueOf(n, "arn") ?? valueOf(n, "Arn") ?? valueOf(n, "topicName") ?? valueOf(n, "queueName") ?? valueOf(n, "Ref");
  if (!raw) return null;
  const text = raw.replace(/^["']|["']$/g, "").trim();
  const tagged = /^!GetAtt\s+([\w-]+)(?:\.\w+)?$/.exec(text) ?? /^!Ref\s+([\w-]+)$/.exec(text);
  if (tagged) return tagged[1]!;
  if (text.startsWith("arn:")) return text.split(":").pop() || text;
  return text;
}

/** One SLS/SAM event as an entry point: `schedule` a scheduled job, a queue/topic/stream a consumer; anything else nothing. */
function eventEntry(type: string, ev: SpecNode | undefined, name: string, handler: string | null, framework: string): EntryPointInfo | null {
  const line = ev?.line ?? 1;
  const at = (e: Omit<EntryPointInfo, "line" | "framework">): EntryPointInfo => ({ ...e, line, framework, ...(handler ? { handler } : {}) });
  switch (type) {
    case "schedule": case "Schedule": case "ScheduleV2": {
      const props = framework === "sam" ? childOf(ev, "Properties") : ev;
      const expr = props?.value ?? valueOf(props, "rate") ?? valueOf(props, "Schedule") ?? valueOf(props, "ScheduleExpression")
        ?? childOf(props, "rate")?.items?.[0]?.value ?? null;
      return at({ kind: "scheduled-job", name, ...(expr ? { schedule: expr.replace(/^["']|["']$/g, "") } : {}) });
    }
    case "sqs": case "SQS": case "sns": case "SNS": case "stream": case "DynamoDB": case "Kinesis": case "eventBridge": case "EventBridgeRule": {
      const props = framework === "sam" ? childOf(ev, "Properties") : ev;
      const src = type === "sqs" || type === "SQS" ? (framework === "sam" ? childOf(props, "Queue") : props)
        : type === "sns" || type === "SNS" ? (framework === "sam" ? childOf(props, "Topic") : props)
        : type === "eventBridge" || type === "EventBridgeRule" ? undefined
        : framework === "sam" ? childOf(props, "Stream") : props;
      // An EventBridge rule with a schedule is a clock, not a message.
      const rate = type === "eventBridge" ? valueOf(props, "schedule") : type === "EventBridgeRule" ? valueOf(props, "ScheduleExpression") : null;
      if (rate) return at({ kind: "scheduled-job", name, schedule: rate });
      const queue = resourceName(src) ?? (type === "eventBridge" || type === "EventBridgeRule" ? valueOf(props, "eventBus") ?? "eventbridge" : null);
      return queue ? at({ kind: "message-consumer", name: queue }) : null;
    }
    default:
      return null;
  }
}

/** Functions a clock or a queue runs, as the descriptor states it (see `eventEntry`). */
export function extractServerlessEntryPoints(lines: string[]): EntryPointInfo[] {
  const root = parseOpenApiDocument(lines);
  const out: EntryPointInfo[] = [];
  if (root.children.has("Resources")) {
    const globals = childOf(childOf(root, "Globals"), "Function");
    for (const [name, res] of childOf(root, "Resources")?.children ?? []) {
      if (valueOf(res, "Type") !== "AWS::Serverless::Function") continue;
      const props = childOf(res, "Properties");
      const handler = valueOf(props, "Handler") ?? valueOf(globals, "Handler");
      const codeUri = valueOf(props, "CodeUri") ?? valueOf(globals, "CodeUri");
      const written = handler ? (handler.includes("::") ? handler : join(codeUri, handler)) : null;
      for (const [, ev] of childOf(props, "Events")?.children ?? []) {
        const e = eventEntry(valueOf(ev, "Type") ?? "", ev, name, written, "sam");
        if (e) out.push(e);
      }
    }
    return out;
  }
  for (const [name, fn] of childOf(root, "functions")?.children ?? []) {
    const handler = valueOf(fn, "handler");
    for (const item of childOf(fn, "events")?.items ?? []) {
      for (const [type, ev] of item.children) {
        const e = eventEntry(type, ev, name, handler, "serverless");
        if (e) out.push(e);
      }
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
  extractEntryPoints: (lines) => extractServerlessEntryPoints(lines),
};
