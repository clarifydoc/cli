import type { ClassInfo, FileAnalysis, PropertyInfo, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Apache Thrift service contracts (`.thrift`):
 *
 *   namespace java com.example.league
 *   include "shared.thrift"
 *   struct Club { 1: required string name, 2: optional i32 founded, 3: list<Player> squad }
 *   service ClubService extends shared.BaseService {
 *     Club getClub(1: string id) throws (1: NotFound nf),        → POST /com.example.league.ClubService/getClub
 *     oneway void ping()
 *   }
 *
 * Thrift has no URL of its own: every language's generated client calls a
 * method by NAME over a transport. So a method is a contract row the way a
 * gRPC rpc is — `POST /<namespace>.<Service>/<method>`, the namespace being
 * the `java` one (else `*`, else the first stated) — handled by the method's
 * name, which is how the generated `Iface` is implemented in every language,
 * and carrying `{ type: <namespace>.<Service>, method }` as its `contract`.
 * The arguments are the generated `<method>_args` struct: one body-bound
 * parameter of the class `<Service>_<method>_args`, a class of the method's
 * fields. A service that `extends` another serves the base's methods too (the
 * route resolver below copies them across files). Structs, unions, exceptions
 * and enums are classes (an enum's values are static properties), not
 * entities: they are what goes over the wire.
 */

/**
 * Comments (`//`, `#`, block) and the contents of string literals blanked, quotes and newlines kept so offsets
 * still give line numbers. A string's contents are default values and annotation text, never declarations: a
 * default `"2: i32 fake"` must not read as a field, nor an escaped quote end the string early.
 */
function blankComments(text: string): string {
  return text.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, (m) =>
    m[0] === '"' || m[0] === "'" ? m[0] + " ".repeat(m.length - 2) + m[0] : m.replace(/[^\n]/g, " "),
  );
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

/** The offset of the closing bracket matching the opener at `open`, or -1. */
function matching(text: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // Strings are blanked already (no escapes or brackets inside); a lone quote, unterminated on its
      // line, is an ordinary character and never starts a string that swallows the rest of the file.
      const close = text.indexOf(ch, i + 1);
      const eol = text.indexOf("\n", i + 1);
      if (close >= 0 && (eol < 0 || close < eol)) i = close;
    } else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

interface Block {
  kind: string;
  name: string;
  base: string | null;
  at: number;
  /** Offsets of the body, inside the braces. */
  start: number;
  end: number;
}

function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  const re = /\b(struct|union|exception|enum|senum|service)\s+(\w+)(?:\s+extends\s+([\w.]+))?\s*\{/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = matching(text, open, "{", "}");
    if (close < 0) break;
    out.push({ kind: m[1]!, name: m[2]!, base: m[3] ?? null, at: m.index, start: open + 1, end: close });
    re.lastIndex = close + 1;
  }
  return out;
}

/** `list<Player>` → `Player[]`, `map<string, Player>` → `map<string,Player>`, spaces dropped. */
export function normalizeType(raw: string): string {
  const t = raw.replace(/\s+/g, "");
  const m = /^(list|set)<(.*)>$/.exec(t);
  if (m) return `${normalizeType(m[2]!)}[]`;
  const map = /^map<(.*)>$/.exec(t);
  if (map) {
    let depth = 0;
    const s = map[1]!;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "<") depth++;
      else if (s[i] === ">") depth--;
      else if (s[i] === "," && depth === 0) return `map<${normalizeType(s.slice(0, i))},${normalizeType(s.slice(i + 1))}>`;
    }
  }
  return t;
}

const TYPE = String.raw`[\w.]+(?:\s*<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?`;

interface Field {
  name: string;
  type: string;
  required: boolean;
}

function fieldsIn(text: string): Field[] {
  const out: Field[] = [];
  const re = new RegExp(String.raw`(?:^|[,;{\s])-?\d+\s*:\s*(?:(required|optional)\s+)?(${TYPE})\s+(\w+)`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ name: m[3]!, type: normalizeType(m[2]!), required: m[1] === "required" });
  return out;
}

const toProps = (fields: Field[]): PropertyInfo[] =>
  fields.map((f) => ({ name: f.name, type: f.type, visibility: "public" as const, isStatic: false, isReadonly: false, ...(f.required ? { isRequired: true } : {}) }));

/** The namespace a service's contract type is qualified with: `java`, else `*`, else the first stated. */
export function namespaceOf(text: string): string {
  const all = [...text.matchAll(/^\s*namespace\s+([\w.*]+)\s+([\w.]+)/gm)];
  return (all.find((m) => m[1] === "java") ?? all.find((m) => m[1] === "*") ?? all[0])?.[2] ?? "";
}

export const THRIFT_SERVICE = "thrift-service";

interface Method {
  name: string;
  line: number;
  fields: Field[];
}

export interface ThriftServiceFact {
  /** The qualified contract type (`com.example.league.ClubService`). */
  type: string;
  name: string;
  line: number;
  /** The `extends` clause as written (`shared.BaseService`). */
  base: string | null;
  methods: Method[];
}

function methodsOf(text: string, svc: Block, lineAt: (offset: number) => number): Method[] {
  const out: Method[] = [];
  const re = new RegExp(String.raw`(?:^|[,;{}\s])(?:oneway\s+)?(?:void|${TYPE})\s+(\w+)\s*\(`, "g");
  re.lastIndex = svc.start;
  for (let m = re.exec(text); m && m.index < svc.end; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    const close = matching(text, open, "(", ")");
    if (close < 0 || close > svc.end) break;
    out.push({ name: m[1]!, line: lineAt(open), fields: fieldsIn(text.slice(open + 1, close)) });
    // `throws (…)` and annotations `( … )` follow the arguments: skip them.
    let end = close + 1;
    for (;;) {
      const t = /^\s*(?:throws\s*)?\(/.exec(text.slice(end, end + 40));
      if (!t) break;
      const c = matching(text, end + t[0].length - 1, "(", ")");
      if (c < 0) break;
      end = c + 1;
    }
    re.lastIndex = end;
  }
  return out;
}

const argsClass = (service: string, method: string): string => `${service}_${method}_args`;

function routeOf(type: string, service: string, m: Method, line = m.line): RouteInfo {
  return {
    path: `/${type}/${m.name}`,
    httpMethod: "POST",
    kind: "api",
    handler: m.name,
    contract: { type, method: m.name },
    calls: [],
    middleware: [],
    line,
    params: [{ name: "args", type: argsClass(service, m.name), binding: "body" as const }],
  };
}

export function extractThriftRoutes(lines: string[], facts?: RouteFact[]): RouteInfo[] {
  const { text, lineAt } = prepared(lines);
  const ns = namespaceOf(text);
  const routes: RouteInfo[] = [];
  for (const svc of blocksOf(text).filter((b) => b.kind === "service")) {
    const type = ns ? `${ns}.${svc.name}` : svc.name;
    const methods = methodsOf(text, svc, lineAt);
    for (const m of methods) routes.push(routeOf(type, svc.name, m));
    facts?.push({ kind: THRIFT_SERVICE, line: lineAt(svc.at), data: { type, name: svc.name, line: lineAt(svc.at), base: svc.base, methods } satisfies ThriftServiceFact });
  }
  return routes;
}

export function extractThriftClasses(lines: string[]): ClassInfo[] {
  const { text, lineAt } = prepared(lines);
  const out: ClassInfo[] = [];
  const cls = (name: string, decorator: string, properties: PropertyInfo[], at: number, end: number): ClassInfo => ({
    name, extends: null, implements: [], decorators: [decorator], methods: [], properties, isExported: true, line: lineAt(at), endLine: lineAt(end),
  });
  for (const b of blocksOf(text)) {
    const body = text.slice(b.start, b.end);
    if (b.kind === "service") {
      for (const m of methodsOf(text, b, lineAt)) out.push(cls(argsClass(b.name, m.name), "thrift-args", toProps(m.fields), b.at, b.end));
    } else if (b.kind === "enum" || b.kind === "senum") {
      const values = [...body.matchAll(/(?:^|[,;{\s])([A-Za-z_]\w*)\s*(?:=\s*[-\w]+)?\s*(?=[,;\s]|$)/g)].map((m) => m[1]!);
      out.push(cls(b.name, "thrift-enum", values.map((v) => ({ name: v, type: "i32", visibility: "public" as const, isStatic: true, isReadonly: true })), b.at, b.end));
    } else {
      out.push(cls(b.name, `thrift-${b.kind}`, toProps(fieldsIn(body)), b.at, b.end));
    }
  }
  return out;
}

/** A service that `extends` another serves the base's methods under its own name (the base may be in an included file). */
export const thriftInheritance: RouteResolver = {
  id: "thrift-service-extends",
  languages: ["thrift"],
  priority: 50,
  resolve(analyses: FileAnalysis[]): void {
    const services = new Map<string, Array<{ file: FileAnalysis; fact: ThriftServiceFact }>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== THRIFT_SERVICE) continue;
        const fact = f.data as ThriftServiceFact;
        (services.get(fact.name) ?? services.set(fact.name, []).get(fact.name)!).push({ file: a, fact });
      }
    }
    const inherited = (fact: ThriftServiceFact, seen: Set<string>): Array<Method & { service: string }> => {
      if (!fact.base || seen.has(fact.type)) return [];
      seen.add(fact.type);
      const hits = services.get(fact.base.split(".").pop()!) ?? [];
      // The one service of that name; a qualifier (`shared.BaseService`) picks among several by the include's stem.
      const prefix = fact.base.includes(".") ? fact.base.split(".")[0]! : null;
      const pick = hits.length > 1 && prefix ? hits.filter((h) => h.file.filePath.split("/").pop()!.replace(/\.thrift$/, "") === prefix) : hits;
      if (pick.length !== 1) return [];
      const base = pick[0]!.fact;
      return [...base.methods.map((m) => ({ ...m, service: base.name })), ...inherited(base, seen)];
    };
    for (const list of services.values()) {
      for (const { file, fact } of list) {
        const own = new Set(fact.methods.map((m) => m.name));
        for (const m of inherited(fact, new Set())) {
          if (own.has(m.name)) continue;
          own.add(m.name);
          file.routes.push(routeOf(fact.type, m.service, m, fact.line));
        }
      }
    }
  },
};

export const thriftSpec: RegexLangSpec = {
  language: "thrift",
  extensions: [".thrift"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [{ pattern: /^\s*include\s+"([^"]+)"/, getSource: (m) => m[1]! }],
  lineCommentPrefixes: ["//", "#"],
  extractRoutes: (lines, _classes, _filePath, _functions, facts) => extractThriftRoutes(lines, facts),
  extractClasses: (lines) => extractThriftClasses(lines),
};
