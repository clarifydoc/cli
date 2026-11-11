import type { FileAnalysis, Language, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

/**
 * Thrift servers whose handler class the generated code never names. Java, Kotlin and C# state it
 * (`implements ClubService.Iface`, read by `thriftServiceOf`); Go, Python and Node hand any object to the
 * generated processor:
 *
 *   processor := league.NewClubServiceProcessor(&clubHandler{})        // Go
 *   processor = ClubService.Processor(ClubHandler())                   # Python
 *   thrift.createServer(ClubService, new ClubHandler())                // Node
 *
 * A language's route extractor reports the call as a `thrift-handler` fact (the service and the handler's
 * type as written, `handler` being a variable the file assigns from a literal or constructor call). The
 * resolver below joins it, once every file is read, with the service a `.thrift` declares and the class that
 * defines the handler: each rpc the class has a method for becomes a contract row ON that method, which the
 * `.thrift` row's spec join then finds — the same shape a grpc-js `addService` handler has. A service no
 * `.thrift` declares, a handler type no unique class carries, and a method the class lacks yield nothing, so
 * an unrelated class with the same method names that no processor receives links to nothing.
 */
export const THRIFT_HANDLER = "thrift-handler";

export interface ThriftHandlerFact {
  /** The service's simple name (`ClubService`). */
  service: string;
  /** The handler's type or constructor as written, `New` stripped (`clubHandler`, `ClubHandler`); empty for an object literal. */
  handler: string;
  /** Node: the variable holding an object-literal handler (`const handler = { getClub() {…} }`), whose functions are `handler.getClub`. */
  holder?: string;
  /** Node: the methods of an object literal written in the call itself, with their lines. */
  methods?: Array<{ name: string; line: number }>;
}

type Dialect = "go" | "python" | "js";

/** `x := &clubHandler{}`, `x := NewClubHandler()` / `x = ClubHandler()` / `const x = new ClubHandler()` → the type name. */
function typeOfVariable(text: string, name: string, dialect: Dialect): string | null {
  const id = name.replace(/\$/g, "\\$");
  const re =
    dialect === "go" ? new RegExp(String.raw`\b${id}\s*(?::=|=(?!=))\s*&?(?:[\w]+\.)?(?:New(?=[A-Z]\w*\s*\()|(?!New[A-Z]\w*\s*\())(\w+)\s*[({]`)
    : dialect === "python" ? new RegExp(String.raw`^\s*${id}\s*=(?!=)\s*(?:[\w]+\.)*(\w+)\s*\(`, "m")
    : new RegExp(String.raw`\b${id}\s*=(?!=)\s*new\s+(?:[\w$]+\.)*([\w$]+)\s*\(`);
  const hits = new Set([...text.matchAll(new RegExp(re.source, re.flags + "g"))].map((m) => m[1]!));
  return hits.size === 1 ? [...hits][0]! : null;
}

/** The argument naming the handler: a literal or constructor call (the type), or a variable (its assignment's type). */
function handlerOf(arg: string, text: string, dialect: Dialect): string | null {
  const a = arg.trim();
  const direct =
    dialect === "go" ? /^&?(?:[\w]+\.)?(?:New(?=[A-Z]\w*\s*\()|(?!New[A-Z]\w*\s*\())(\w+)\s*[({]/.exec(a)
    : dialect === "python" ? /^(?:[\w]+\.)*(\w+)\s*\(/.exec(a)
    : /^new\s+(?:[\w$]+\.)*([\w$]+)\s*\(/.exec(a);
  if (direct) return direct[1]!;
  const ident = /^[\w$]+$/.exec(a)?.[0];
  return ident ? typeOfVariable(text, ident, dialect) : null;
}

/** The text of the balanced `{ … }` starting at `start`, or null. Strings and comments are skipped. */
function balancedBraces(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** The function-valued members of an object literal: `getClub(id) {…}`, `async list() {…}`, `ping: () => …`, `x: function (…) {…}`. */
function literalMethods(literal: string, firstLine: number): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  let depth = 0;
  let segStart = 1;
  const flush = (end: number) => {
    const seg = literal.slice(segStart, end);
    const m = /^\s*(?:async\s+)?\*?\s*(?:["']?)([A-Za-z_$][\w$]*)(?:["']?)\s*(?:\(|:\s*(?:async\b\s*)?(?:function\b|\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>))/.exec(seg);
    if (m) out.push({ name: m[1]!, line: firstLine + literal.slice(0, segStart + seg.search(/\S/)).split("\n").length - 1 });
  };
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i]!;
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < literal.length && literal[i] !== c; i++) if (literal[i] === "\\") i++;
    } else if (c === "/" && literal[i + 1] === "/") {
      while (i < literal.length && literal[i] !== "\n") i++;
    } else if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) {
      depth--;
      if (depth === 0) flush(i);
    } else if (c === "," && depth === 1) {
      flush(i);
      segStart = i + 1;
    }
  }
  return out;
}

const ARG = String.raw`((?:[^(),]|\((?:[^()]|\([^()]*\))*\))+)`;

/** The `thrift-handler` facts a file's text states. */
export function thriftHandlerFacts(sourceText: string, dialect: Dialect): RouteFact[] {
  const re =
    dialect === "go" ? new RegExp(String.raw`\bNew([A-Z]\w*)Processor(?:WithOptions)?\(\s*${ARG}`, "g")
    : dialect === "python" ? new RegExp(String.raw`\b([A-Z]\w*)\.Processor\(\s*${ARG}`, "g")
    : new RegExp(String.raw`\bcreate(?:Multiplexed)?Server\(\s*(?:[\w$]+\.)*([A-Z]\w*)\s*,\s*${ARG}`, "g");
  if (!(dialect === "go" ? /Processor/ : dialect === "python" ? /\.Processor\(/ : /createServer|createMultiplexedServer/).test(sourceText)) return [];
  // Whole-line comments are not code.
  const blank = (c: string) => c.replace(/[^\n]/g, " ");
  let text = sourceText.replace(dialect === "js" ? /^\s*\/\/.*$/gm : dialect === "python" ? /^\s*#.*$/gm : /^\s*\/\/.*$/gm, blank);
  if (dialect !== "python") text = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  // A Node `createServer` is any server's: an object literal handler counts only in a file naming the thrift package.
  const namesThrift = dialect !== "js" || /thrift/i.test(sourceText);
  const out: RouteFact[] = [];
  for (const m of text.matchAll(re)) {
    const line = text.slice(0, m.index!).split("\n").length;
    if (dialect === "js" && namesThrift) {
      // An object literal: written in the call, or held by a variable the file declares with one.
      const argAt = m.index! + m[0].length - m[2]!.length;
      const lead = m[2]!.search(/\S/);
      if (m[2]![lead] === "{") {
        const literal = balancedBraces(text, argAt + lead);
        const first = text.slice(0, argAt + lead).split("\n").length;
        const methods = literal ? literalMethods(literal, first) : [];
        if (methods.length) out.push({ kind: THRIFT_HANDLER, line, data: { service: m[1]!, handler: "", methods } satisfies ThriftHandlerFact });
        continue;
      }
      const ident = /^[\w$]+$/.exec(m[2]!.trim())?.[0];
      if (ident && new RegExp(String.raw`\b(?:const|let|var)\s+${ident.replace(/\$/g, "\\$")}\s*(?::[^=]+)?=\s*\{`).test(text)) {
        out.push({ kind: THRIFT_HANDLER, line, data: { service: m[1]!, handler: "", holder: ident } satisfies ThriftHandlerFact });
        continue;
      }
    }
    const handler = handlerOf(m[2]!, text, dialect);
    if (!handler) continue;
    out.push({ kind: THRIFT_HANDLER, line, data: { service: m[1]!, handler } satisfies ThriftHandlerFact });
  }
  return out;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Join each `thrift-handler` fact to the rpcs of the declared service and the handler class's methods. */
export const thriftHandlers: RouteResolver = {
  id: "thrift-handlers",
  languages: ["thrift", "go", "python", "javascript", "typescript"] satisfies Language[],
  // After the service-extends pass, so a handler of a derived service also serves the base's rpcs.
  priority: 60,
  resolve(analyses: FileAnalysis[]): void {
    // The rpcs of each declared service: simple name → qualified type → methods.
    const declared = new Map<string, Map<string, Set<string>>>();
    for (const a of analyses) {
      if (a.language !== "thrift") continue;
      for (const r of a.routes) {
        if (!r.contract) continue;
        const leaf = r.contract.type.slice(r.contract.type.lastIndexOf(".") + 1);
        const byType = declared.get(leaf) ?? declared.set(leaf, new Map()).get(leaf)!;
        (byType.get(r.contract.type) ?? byType.set(r.contract.type, new Set()).get(r.contract.type)!).add(r.contract.method);
      }
    }
    if (declared.size === 0) return;

    for (const a of analyses) {
      if (a.language === "thrift") continue;
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== THRIFT_HANDLER) continue;
        const fact = f.data as ThriftHandlerFact;
        const types = declared.get(fact.service);
        // Two services of one name in different namespaces: the source does not say which.
        if (!types || types.size !== 1) continue;
        const methods = [...types.values()][0]!;
        if (fact.methods || fact.holder) {
          // An object literal: its members are the rpcs' handlers, the held ones as functions `<holder>.<method>`.
          const members = fact.methods ?? a.functions.filter((x) => x.name.startsWith(`${fact.holder}.`) && !x.name.slice(fact.holder!.length + 1).includes(".")).map((x) => ({ name: x.name.slice(fact.holder!.length + 1), line: x.line }));
          for (const method of methods) {
            const own = members.filter((x) => sameName(x.name, method));
            if (own.length !== 1) continue;
            const handler = fact.holder ? `${fact.holder}.${own[0]!.name}` : `createServer.${own[0]!.name}`;
            if (a.routes.some((r) => r.contract?.type === fact.service && r.contract.method === method && r.handler === handler)) continue;
            a.routes.push({
              path: `${fact.service}#${method}`,
              httpMethod: null,
              kind: "api",
              handler,
              contract: { type: fact.service, method },
              prefixUnresolved: `contract:${fact.service}`,
              calls: [],
              middleware: [],
              line: own[0]!.line,
            });
          }
          continue;
        }
        // The handler's class: the one of that name, own file and language first, never an ambiguous pick.
        const classes = analyses.flatMap((x) => x.classes.filter((c) => sameName(c.name, fact.handler)).map((cls) => ({ file: x, cls })));
        const own = classes.filter((c) => c.file === a);
        const pick = own.length === 1 ? own : classes.filter((c) => c.file.language === a.language);
        if (pick.length !== 1) continue;
        const { file, cls } = pick[0]!;
        for (const method of methods) {
          const m = cls.methods.filter((x) => sameName(x.name, method));
          if (m.length !== 1) continue;
          const handler = `${cls.name}.${m[0]!.name}`;
          if (file.routes.some((r) => r.contract?.type === fact.service && r.contract.method === method && r.handler === handler)) continue;
          const route: RouteInfo = {
            path: `${fact.service}#${method}`,
            httpMethod: null,
            kind: "api",
            handler,
            contract: { type: fact.service, method },
            prefixUnresolved: `contract:${fact.service}`,
            calls: [],
            middleware: [],
            line: m[0]!.line,
          };
          file.routes.push(route);
        }
      }
    }
  },
};
