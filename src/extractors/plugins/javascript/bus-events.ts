import type { Node, Tree } from "web-tree-sitter";
import type { BusEventSite, FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { resolveTarget, buildFilePathMap } from "../../shared/link-scoring.js";
import { EMITTER_NAME_RE } from "./data-sources.js";
import { innermostAt, spansOf, type SymbolSpan } from "./dispatch.js";

/** A bus call: `emitter.emit(…)`, `bus.$on(…)`, `events.once(…)`. */
const BUS_METHODS = new Map([["emit", "emit"], ["$emit", "emit"], ["on", "listen"], ["$on", "listen"], ["once", "listen"], ["$once", "listen"], ["addListener", "listen"]] as const);
/** A module-level name the file creates as a bus: `const bus = mitt()`, `new EventEmitter()`, a Vue 2 `new Vue()`. */
const CREATES_BUS = /^(?:mitt|createNanoEvents|emitter)\s*\(|^new\s+(?:\w+\.)?(?:EventEmitter\d*|Vue|TinyEmitter|Emitter)\s*\(/;
/** A constant's name: `CMD_RELOAD`, `LEAGUE_EVENTS.CLUB_SAVED`. */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition"]);

/**
 * The calls a file makes on an app-wide event bus (`FileAnalysis.busEvents`):
 *
 *     emitter.emit(LEAGUE_EVENTS.CLUB_SAVED, club);          // emit, by a constant
 *     emitter.on(LEAGUE_EVENTS.CLUB_SAVED, this.refreshClubs);  // listen, with a method
 *     export const useBusListener = (eventName, callback) =>    // a wrapper: event #0, handler #1
 *       onMounted(() => emitter.on(eventName, callback));
 *     useBusListener(CMD_RELOAD_SQUAD, loadSquad);           // a call a wrapper may answer
 *
 * The bus is a module-level name — imported, or created here — that reads like a bus
 * or that the file creates as one; never `this` (a component's own emit) or a local.
 * An event is a literal, a module constant (a literal one is written as its value),
 * or a parameter of the named function the call sits in; anything else is no site.
 * An inline listener names no function and is left out.
 */
export function busEvents(tree: Tree, sourceText: string): BusEventSite[] {
  const direct = /\.\$?(?:emit|on|once|addListener)\s*\(/.test(sourceText);
  if (!direct && !/\b[A-Za-z_$][\w$]*\s*\(\s*(?:['"]|[A-Z][\w$]*[.,\s])/.test(sourceText)) return [];
  const root = tree.rootNode;
  const imported = new Set<string>();
  const declared = new Map<string, Node | null>();
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "import_statement") {
      for (const id of stmt.descendantsOfType(["identifier"])) {
        // The local names: a default, a namespace, a named import or its alias (never the module's own name before `as`).
        const p = id?.parent;
        if (!id || (p?.type === "import_specifier" && p.childForFieldName("alias") && p.childForFieldName("name")?.id === id.id)) continue;
        imported.add(id.text);
      }
      continue;
    }
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
    if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
    for (const d of decl.namedChildren) {
      const name = d?.type === "variable_declarator" ? d.childForFieldName("name") : null;
      if (name?.type === "identifier") declared.set(name.text, d!.childForFieldName("value"));
    }
  }
  const moduleBound = (name: string) => imported.has(name) || declared.has(name);
  const isBus = (name: string) => {
    if (!moduleBound(name)) return false;
    const value = declared.get(name);
    return EMITTER_NAME_RE.test(name) || (!!value && CREATES_BUS.test(value.text));
  };

  /** `#n` when `name` is parameter n of the named function enclosing `at` (its name in `within`). */
  const paramOf = (name: string, at: Node): { ref: string; within: string } | null => {
    for (let fn = at.parent; fn; fn = fn.parent) {
      if (!FUNCTION_NODES.has(fn.type)) continue;
      const index = paramNames(fn).indexOf(name);
      if (index < 0) continue;
      const within = functionName(fn);
      return within ? { ref: `#${index}`, within } : null;
    }
    return null;
  };
  /** A literal, a module constant, or a parameter of the named enclosing function. */
  const eventOf = (n: Node | null | undefined, constantsOnly: boolean): { ref: string; within?: string } | null => {
    if (!n) return null;
    const literal = literalText(n);
    if (literal !== null) return { ref: `'${literal}'` };
    if (n.type === "identifier") {
      const value = declared.get(n.text);
      const held = value ? literalText(value) : null;
      if (held !== null) return CONSTANT_NAME.test(n.text) || !constantsOnly ? { ref: `'${held}'` } : null;
      if (moduleBound(n.text)) return !constantsOnly || CONSTANT_NAME.test(n.text) ? { ref: n.text } : null;
      return constantsOnly ? null : paramOf(n.text, n);
    }
    if (n.type === "member_expression" && /^[A-Za-z_$][\w$]*(?:\.[\w$]+)+$/.test(n.text)) {
      const parts = n.text.split(".");
      if (!moduleBound(parts[0]!) || (constantsOnly && !CONSTANT_NAME.test(parts[parts.length - 1]!))) return null;
      return { ref: n.text };
    }
    return null;
  };
  /** A function by name: one the file declares or imports, `this.method`, or a parameter of the named enclosing function. */
  const handlerOf = (n: Node | null | undefined): { ref: string; within?: string } | null => {
    if (!n) return null;
    if (n.type === "member_expression" && /^this\.[A-Za-z_$][\w$]*$/.test(n.text)) return { ref: n.text };
    if (n.type !== "identifier") return null;
    return paramOf(n.text, n) ?? { ref: n.text };
  };

  const out: BusEventSite[] = [];
  const visit = (n: Node): void => {
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).filter((a): a is Node => !!a && a.type !== "comment");
      const line = n.startPosition.row + 1;
      const kind = fn?.type === "member_expression" ? BUS_METHODS.get(fn.childForFieldName("property")?.text as never) : undefined;
      const receiver = fn?.type === "member_expression" ? fn.childForFieldName("object") : null;
      if (kind && receiver?.type === "identifier" && isBus(receiver.text) && args.length >= (kind === "listen" ? 2 : 1)) {
        const event = eventOf(args[0], false);
        const handler = kind === "listen" ? handlerOf(args[1]) : null;
        const within = event?.within ?? handler?.within;
        // One named function supplies whatever it hands on: a site mixing two scopes is no site.
        if (event && (kind === "emit" || handler) && (!event.within || !handler?.within || event.within === handler.within)) {
          out.push({ kind, bus: receiver.text, event: event.ref, ...(handler ? { handler: handler.ref } : {}), ...(within ? { within } : {}), line });
        }
      } else if (fn?.type === "identifier" && imported.has(fn.text) && args.length >= 2 && args.length <= 4) {
        // A call a wrapper may answer: an event-like constant or literal beside a function by name.
        const events = args.map((a) => eventOf(a, true));
        const handlers = args.map((a) => (a.type === "identifier" || a.type === "member_expression" ? handlerOf(a) : null));
        if (events.some((e) => e && !e.within) && handlers.some((h, i) => h && !h.within && !events[i])) {
          out.push({ kind: "call", bus: fn.text, args: args.map((_, i) => events[i]?.ref ?? (handlers[i] && !handlers[i]!.within ? handlers[i]!.ref : "")), line });
        }
      }
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(root);
  return out;
}

/** A string literal's value, when it holds no interpolation and reads like an event name. */
function literalText(n: Node): string | null {
  if (n.type !== "string" && !(n.type === "template_string" && !n.text.includes("${"))) return null;
  const value = n.text.slice(1, -1);
  return /^[\w:./-]{1,80}$/.test(value) ? value : null;
}

/** The names a function binds as parameters, in order (a destructured one is a blank). */
function paramNames(fn: Node): string[] {
  const single = fn.childForFieldName("parameter");
  if (single) return [single.text];
  return (fn.childForFieldName("parameters")?.namedChildren ?? []).filter((p): p is Node => !!p && p.type !== "comment").map((p) => {
    const pattern = p.childForFieldName("pattern") ?? p;
    const name = pattern.type === "assignment_pattern" ? pattern.childForFieldName("left") : pattern;
    return name?.type === "identifier" ? name.text : "";
  });
}

/** A function's own name, or the variable or member it is assigned to; null for an anonymous callback. */
function functionName(fn: Node): string | null {
  const own = fn.childForFieldName("name");
  if (own && fn.type !== "function_expression" && fn.type !== "function") return own.text;
  const p = fn.parent;
  if (p?.type === "variable_declarator") return p.childForFieldName("name")?.type === "identifier" ? p.childForFieldName("name")!.text : null;
  if (p?.type === "pair") return p.childForFieldName("key")?.text ?? null;
  return own?.text ?? null;
}

/**
 * Whether two files can run in one page: a bus module two apps import (an admin
 * dashboard and an embedded widget built from their own entries) is one instance per
 * app, and an emit in one never reaches a listener in the other. Each file is reached
 * through imports (dynamic ones too) from the entries that mount an app
 * (`FileAnalysis.appMount`); two files share a page when one entry reaches both, or when
 * either is reached by none (nothing says otherwise). Fewer than two entries, always.
 */
function sharedBundle(analyses: FileAnalysis[], filePathMap: Map<string, string>, byPath: Map<string, FileAnalysis>): (a: string, b: string) => boolean {
  const entries = analyses.filter((a) => a.appMount);
  if (entries.length < 2 || entries.length > 30) return () => true;
  const reached = new Map<string, number>();
  entries.forEach((entry, i) => {
    const bit = 2 ** i;
    const stack = [entry.filePath];
    while (stack.length > 0) {
      const file = stack.pop()!;
      const seen = reached.get(file) ?? 0;
      if (seen & bit) continue;
      reached.set(file, seen | bit);
      for (const imp of byPath.get(file)?.imports ?? []) {
        const next = resolveTarget(imp.source, file, filePathMap);
        if (next && byPath.has(next) && !((reached.get(next) ?? 0) & bit)) stack.push(next);
      }
    }
  });
  return (a, b) => {
    const x = reached.get(a) ?? 0;
    const y = reached.get(b) ?? 0;
    return x === 0 || y === 0 || (x & y) !== 0;
  };
}

/** A listener a click on the emitting side never reaches in production. */
const TEST_OR_STORY = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec)\/|\.(?:spec|test|stories|story)\.[cm]?[jt]sx?$|\.story\.vue$/;

/**
 * An app-wide event bus: an emit joined to the functions listening to the same event
 * on the same bus (`FileAnalysis.busEvents`). The bus is the module export the emitter
 * and the listener both read (`import { emitter } from '…/bus'`), resolved through each
 * file's imports; the event is the same literal, or the same constant of the same module.
 * A listener registered through a project wrapper (`useBusListener(CMD_RELOAD, loadSquad)`,
 * where the wrapper calls `emitter.on(eventName, callback)` with its parameters) is the
 * caller's function. One link per emitting function and listener, callName as written;
 * a listener in a test or a story is never joined to production code.
 */
export class JsEventBusResolver implements DispatchResolver {
  readonly id = "event-bus";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 34;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const withSites = analyses.filter((a) => a.busEvents?.length);
    if (withSites.length === 0) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    const spanCache = new Map<FileAnalysis, SymbolSpan[]>();
    const spans = (a: FileAnalysis) => spanCache.get(a) ?? spanCache.set(a, spansOf(a)).get(a)!;

    /** A module-level name of `a` → `<file>#<exported name>`: the module it is imported from, or `a` itself. */
    const identity = (a: FileAnalysis, name: string): string | null => {
      const head = name.split(".")[0]!;
      const rest = name.slice(head.length);
      const imp = a.imports.find((i) => i.specifiers.includes(head) && !i.isType);
      if (!imp) return `${a.filePath}#${name}`;
      const file = resolveTarget(imp.source, a.filePath, filePathMap);
      if (!file || !byPath.has(file)) return null;
      return `${file}#${imp.isNamespace ? rest.slice(1) : `${imp.aliases?.[head] ?? head}${rest}`}`;
    };
    const eventId = (a: FileAnalysis, ref: string): string | null => (ref.startsWith("'") ? ref : ref.startsWith("#") ? null : identity(a, ref));
    /** The function of `a` a handler names. */
    const handlerSpan = (a: FileAnalysis, ref: string): SymbolSpan | undefined => {
      const name = ref.replace(/^this\./, "");
      return spans(a).find((sp) => sp.symbol === name || sp.symbol.endsWith(`.${name}`));
    };

    // Wrappers: a named function listening with its own parameters → which carries the event and the handler.
    const wrappers = new Map<string, { bus: string; event: number; handler: number }>();
    for (const a of withSites) {
      for (const s of a.busEvents!) {
        if (s.kind !== "listen" || !s.within || !s.event?.startsWith("#") || !s.handler?.startsWith("#")) continue;
        const bus = identity(a, s.bus);
        if (bus) wrappers.set(`${a.filePath}#${s.within}`, { bus, event: Number(s.event.slice(1)), handler: Number(s.handler.slice(1)) });
      }
    }

    // Listeners by bus + event.
    const listeners = new Map<string, Array<{ file: string; span: SymbolSpan; test: boolean }>>();
    const listen = (bus: string | null, event: string | null, a: FileAnalysis, handler: string | undefined) => {
      const span = bus && event && handler && !handler.startsWith("#") ? handlerSpan(a, handler) : undefined;
      if (!span) return;
      const key = `${bus}\u0000${event}`;
      const list = listeners.get(key) ?? listeners.set(key, []).get(key)!;
      if (!list.some((l) => l.file === a.filePath && l.span.symbol === span.symbol)) list.push({ file: a.filePath, span, test: TEST_OR_STORY.test(a.filePath) });
    };
    for (const a of withSites) {
      for (const s of a.busEvents!) {
        if (s.kind === "listen") listen(identity(a, s.bus), eventId(a, s.event ?? ""), a, s.handler);
        if (s.kind !== "call" || !wrappers.size) continue;
        const imp = a.imports.find((i) => i.specifiers.includes(s.bus) && !i.isType);
        const file = imp ? resolveTarget(imp.source, a.filePath, filePathMap) : null;
        const w = file ? wrappers.get(`${file}#${imp!.aliases?.[s.bus] ?? s.bus}`) : undefined;
        if (!w) continue;
        listen(w.bus, eventId(a, s.args?.[w.event] ?? ""), a, s.args?.[w.handler] || undefined);
      }
    }
    if (listeners.size === 0) return [];
    const together = sharedBundle(analyses, filePathMap, byPath);

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const a of withSites) {
      const test = TEST_OR_STORY.test(a.filePath);
      for (const s of a.busEvents!) {
        if (s.kind !== "emit") continue;
        const bus = identity(a, s.bus);
        const event = eventId(a, s.event ?? "");
        const from = innermostAt(spans(a), s.line);
        if (!bus || !event || !from) continue;
        for (const l of (listeners.get(`${bus}\u0000${event}`) ?? []).filter((x) => test || !x.test).slice(0, 8)) {
          if ((l.file === a.filePath && l.span.symbol === from.symbol) || !together(a.filePath, l.file)) continue;
          const k = `${a.filePath}\u0000${from.symbol}\u0000${l.file}\u0000${l.span.symbol}`;
          if (seen.has(k)) continue;
          seen.add(k);
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: from.symbol,
            sourceLine: s.line,
            callName: `${s.bus}.emit`,
            targetFile: l.file,
            targetSymbol: l.span.symbol,
            targetLine: l.span.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
