import type { ClassInfo, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Protocol Buffers service contracts (`.proto`):
 *
 *   package acme.orders.v1;
 *   service OrderService {
 *     rpc GetOrder (GetOrderRequest) returns (Order) {   → POST /acme.orders.v1.OrderService/GetOrder
 *       option (google.api.http) = { get: "/v1/orders/{id}" };   → and GET /v1/orders/{id}
 *     }
 *   }
 *   message GetOrderRequest { string id = 1; }           → class GetOrderRequest { id: string }
 *
 * Each `rpc` is a contract row at the path gRPC requests it by — the package-
 * qualified service and the method — handled by the rpc's name, which is how
 * the generated server base is implemented in every language (`SayHello` in
 * Go and C#, `sayHello` in Java and Node), and carrying the service as its
 * `contract`. A grpc-gateway `google.api.http` binding is a second row at
 * its REST path, the one a browser calls. The request message is the
 * body-bound parameter, so the request-schema pass flattens it; messages are
 * classes (nested ones by their own name), not entities: they are what goes
 * over the wire, not what is stored.
 */

/** Comments blanked, newlines kept, so offsets still give line numbers. */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const CACHE = new WeakMap<string[], { text: string; lineAt: (offset: number) => number }>();

function prepared(lines: string[]): { text: string; lineAt: (offset: number) => number } {
  let p = CACHE.get(lines);
  if (!p) {
    const text = blankComments(lines.join("\n"));
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    const lineAt = (offset: number): number => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    };
    p = { text, lineAt };
    CACHE.set(lines, p);
  }
  return p;
}

/** The offset of the `}` closing the block whose `{` is at `open`, or -1. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

interface Block {
  kind: string;
  name: string;
  /** Offset of the block's keyword. */
  at: number;
  /** Offsets of the body, inside the braces. */
  start: number;
  end: number;
}

/** The `service`/`message`/`enum` blocks directly inside `[from, to)`. */
function blocksIn(text: string, from: number, to: number): Block[] {
  const out: Block[] = [];
  const re = /\b(service|message|enum|oneof|extend)\s+([\w.]+)\s*\{/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m && m.index < to; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = blockEnd(text, open);
    if (close < 0 || close > to) break;
    out.push({ kind: m[1]!, name: m[2]!, at: m.index, start: open + 1, end: close });
    re.lastIndex = close + 1;
  }
  return out;
}

const packageOf = (text: string): string => /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1] ?? "";

/** REST path template → route path: `{name=shelves/*}` reads as `{name}`. */
const restPath = (template: string): string => template.replace(/\{([\w.]+)=[^}]*\}/g, "{$1}");

export function extractProtoRoutes(lines: string[]): RouteInfo[] {
  const { text, lineAt } = prepared(lines);
  const pkg = packageOf(text);
  const routes: RouteInfo[] = [];
  for (const svc of blocksIn(text, 0, text.length).filter((b) => b.kind === "service")) {
    const qualified = pkg ? `${pkg}.${svc.name}` : svc.name;
    const rpcRe = /\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*([;{])/g;
    rpcRe.lastIndex = svc.start;
    for (let m = rpcRe.exec(text); m && m.index < svc.end; m = rpcRe.exec(text)) {
      const [, name, , request] = m;
      const line = lineAt(m.index);
      const contract = { type: qualified, method: name! };
      const params = [{ name: "request", type: request!, binding: "body" as const }];
      routes.push({ path: `/${qualified}/${name}`, httpMethod: "POST", kind: "api", handler: name!, contract, calls: [], middleware: [], line, params });
      if (m[6] !== "{") continue;
      const close = blockEnd(text, m.index + m[0].length - 1);
      const body = close > 0 ? text.slice(m.index + m[0].length, close) : "";
      const http = /option\s*\(\s*google\.api\.http\s*\)\s*=\s*\{([\s\S]*?)\}\s*;/.exec(body);
      const binding = http ? /\b(get|post|put|patch|delete)\s*:\s*"([^"]+)"/.exec(http[1]!) : null;
      if (binding) {
        const bodyField = /\bbody\s*:\s*"([^"]*)"/.exec(http![1]!)?.[1];
        routes.push({
          path: restPath(binding[2]!),
          httpMethod: binding[1]!.toUpperCase(),
          kind: "api",
          handler: name!,
          contract,
          calls: [],
          middleware: [],
          line: lineAt(m.index + m[0].length + http!.index),
          ...(bodyField ? { params } : {}),
        });
      }
      if (close > 0) rpcRe.lastIndex = close + 1;
    }
  }
  return routes;
}

function fieldsOf(text: string, block: Block, nested: Block[]): PropertyInfo[] {
  // The message's own statements: nested messages and enums cut out, a oneof's fields kept.
  let body = "";
  let at = block.start;
  for (const n of nested) {
    body += text.slice(at, n.at);
    body += n.kind === "oneof" ? text.slice(n.start, n.end) : ";";
    at = n.end + 1;
  }
  body += text.slice(at, block.end);
  const out: PropertyInfo[] = [];
  for (const stmt of body.split(";")) {
    const m = /^\s*(?:(repeated|optional|required)\s+)?(map\s*<\s*[\w.]+\s*,\s*[\w.]+\s*>|[\w.]+)\s+(\w+)\s*=\s*\d+/.exec(stmt);
    if (!m || m[2] === "option" || m[2] === "reserved") continue;
    const type = m[2]!.replace(/\s+/g, "");
    out.push({
      name: m[3]!,
      type: m[1] === "repeated" ? `${type}[]` : type,
      visibility: "public",
      isStatic: false,
      isReadonly: false,
      ...(m[1] === "required" ? { isRequired: true } : {}),
    });
  }
  return out;
}

export function extractProtoMessages(lines: string[]): ClassInfo[] {
  const { text, lineAt } = prepared(lines);
  const out: ClassInfo[] = [];
  const visit = (block: Block): void => {
    const nested = blocksIn(text, block.start, block.end);
    out.push({
      name: block.name,
      extends: null,
      implements: [],
      decorators: ["protobuf-message"],
      methods: [],
      properties: fieldsOf(text, block, nested),
      isExported: true,
      line: lineAt(block.start),
      endLine: lineAt(block.end),
    });
    for (const n of nested) if (n.kind === "message") visit(n);
  };
  for (const b of blocksIn(text, 0, text.length)) if (b.kind === "message") visit(b);
  return out;
}

export const protobufSpec: RegexLangSpec = {
  language: "protobuf",
  extensions: [".proto"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [{ pattern: /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/, getSource: (m) => m[1]! }],
  lineCommentPrefixes: ["//"],
  extractRoutes: (lines) => extractProtoRoutes(lines),
  extractClasses: (lines) => extractProtoMessages(lines),
};
