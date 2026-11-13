import type { Node, Tree } from "web-tree-sitter";
import type { FileAnalysis, Language, SubjectFlows, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { resolveTarget, buildFilePathMap } from "../../shared/link-scoring.js";
import { inConstructor, injectedLocals, memberTypes, reactiveCellsOf } from "./reactive-cells.js";

const SUBJECT_CLASSES = /^(?:Subject|ReplaySubject|BehaviorSubject|AsyncSubject)$/;
const CLASS_NODES: ReadonlySet<string> = new Set(["class_declaration", "class", "abstract_class_declaration"]);

function classOf(n: Node): Node | null {
  for (let p = n.parent; p; p = p.parent) if (CLASS_NODES.has(p.type)) return p;
  return null;
}

function nameOfClass(cls: Node): string | null {
  return cls.childForFieldName("name")?.text ?? null;
}

/** The innermost named function holding a line: the narrowest, then the last to start. */
function innermost(functions: ReadonlyArray<{ name: string; line: number; endLine: number }>, line: number): string | null {
  let best: { name: string; line: number; endLine: number } | null = null;
  for (const f of functions) {
    if (f.line > line || f.endLine < line) continue;
    if (!best || f.endLine - f.line < best.endLine - best.line || (f.endLine - f.line === best.endLine - best.line && f.line > best.line)) best = f;
  }
  return best?.name ?? null;
}

/**
 * What a member's value exposes of another member: `this.a`, `this.a.asObservable()`, `this.a.pipe(…)` (any chain of
 * the two), or the same on a service the class holds — `this.svc.a`, and in a constructor `svc.a`.
 */
function exposedMember(value: Node, inCtor: boolean): { observes: string; via?: string } | null {
  let n: Node | null = value;
  while (n?.type === "call_expression") {
    const c: Node | null = n.childForFieldName("function");
    const prop = c?.type === "member_expression" ? c.childForFieldName("property")?.text : null;
    if (prop !== "asObservable" && prop !== "pipe") return null;
    n = c!.childForFieldName("object");
  }
  if (n?.type !== "member_expression") return null;
  const observes = n.childForFieldName("property")?.text;
  const holder = n.childForFieldName("object");
  if (!observes) return null;
  if (holder?.type === "this") return { observes };
  if (holder?.type === "member_expression" && holder.childForFieldName("object")?.type === "this") return { observes, via: holder.childForFieldName("property")!.text };
  if (holder?.type === "identifier" && inCtor) return { observes, via: holder.text };
  return null;
}

/**
 * Observable subjects a class holds and the classes that feed and listen to them (`FileAnalysis.subjectFlows`):
 *
 *     export class LeagueService {
 *       readonly changes$ = new Subject<Club>();             // a subject, or `this.#changes.asObservable()`
 *       announce(c: Club) { this.changes$.next(c); }          // a next on its own subject
 *     }
 *     class ClubForm   { save() { this.leagueSvc.changes$.next(c); } }                // a next through a service it holds
 *     class ClubDetail { constructor(private leagueSvc: LeagueService) {
 *       this.leagueSvc.changes$.pipe(switchMap(() => this.http.get('/api/matches'))).subscribe(); } } // a listen
 *
 * A listen's callbacks are held functions of their own (`reactive-cells.ts` `subjectListens`), which is what a
 * `next` elsewhere runs. `JsSubjectResolver` joins them through the service's declared type.
 */
export function subjectFlows(tree: Tree, sourceText: string, functions: ReadonlyArray<{ name: string; line: number; endLine: number }>): SubjectFlows | null {
  if (!/\bInjectable\b|\.pipe\s*\(|\bSubject\b|\bReplaySubject\b|\bBehaviorSubject\b|\bAsyncSubject\b|\.next\s*\(|\.subscribe\s*\(/.test(sourceText)) return null;
  const out: SubjectFlows = {};
  const classes = tree.rootNode.descendantsOfType(["class_declaration", "class", "abstract_class_declaration"]).filter((c): c is Node => !!c);
  const subjects = new Set<string>();
  const types: Record<string, Record<string, string>> = {};
  for (const cls of classes) {
    const name = nameOfClass(cls);
    if (!name) continue;
    const t = memberTypes(cls);
    if (t.size > 0) types[name] = Object.fromEntries(t);
  }
  const locals = new Map<number, Set<string>>();
  const localsOf = (cls: Node) => locals.get(cls.id) ?? locals.set(cls.id, injectedLocals(cls)).get(cls.id)!;
  const typed = (cls: string, member: string) => types[cls]?.[member] !== undefined;
  const isSubjectNew = (value: Node) => value.type === "new_expression" && SUBJECT_CLASSES.test(value.childForFieldName("constructor")?.text ?? "");
  /** Records a member `name` of `className` whose value is `value`: a subject, or what another member or service exposes. */
  const record = (className: string, name: string, value: Node, inCtor: boolean) => {
    if (isSubjectNew(value)) {
      if (subjects.has(`${className}.${name}`)) return;
      subjects.add(`${className}.${name}`);
      (out.subjects ??= []).push({ class: className, field: name });
      return;
    }
    const source = exposedMember(value, inCtor);
    if (out.subjects?.some((x) => x.class === className && x.field === name)) return;
    if (!source || (source.via !== undefined && !typed(className, source.via))) return;
    (out.subjects ??= []).push({ class: className, field: name, observes: source.observes, ...(source.via ? { via: source.via } : {}) });
  };
  for (const cls of classes) {
    const className = nameOfClass(cls);
    if (!className) continue;
    for (const d of cls.descendantsOfType(["public_field_definition", "field_definition"])) {
      if (!d || classOf(d)?.id !== cls.id) continue;
      const name = (d.childForFieldName("name") ?? d.childForFieldName("property"))?.text;
      const value = d.childForFieldName("value");
      if (name && value) record(className, name, value, false);
    }
    for (const m of cls.descendantsOfType("method_definition")) {
      if (!m || classOf(m)?.id !== cls.id) continue;
      const name = m.childForFieldName("name")?.text;
      if (name === "constructor") {
        for (const as of m.descendantsOfType("assignment_expression")) {
          const left = as?.childForFieldName("left");
          const right = as?.childForFieldName("right");
          if (!as || !right || left?.type !== "member_expression" || left.childForFieldName("object")?.type !== "this") continue;
          record(className, left.childForFieldName("property")!.text, right, true);
        }
      } else if (name && m.children.some((c) => c?.type === "get")) {
        const returns = m.descendantsOfType("return_statement");
        const value = returns.length === 1 ? returns[0]?.namedChildren[0] : null;
        if (value) record(className, name, value, false);
      }
    }
  }
  // An exposing member only counts when the chain it names is another member of the class, or a service it holds.
  if (out.subjects) {
    out.subjects = out.subjects.filter((s) => s.via !== undefined || !s.observes || out.subjects!.some((o) => o.class === s.class && o.field === s.observes));
  }
  for (const n of tree.rootNode.descendantsOfType("call_expression")) {
    const callee = n?.childForFieldName("function");
    if (!n || callee?.type !== "member_expression" || callee.childForFieldName("property")?.text !== "next") continue;
    const subject = callee.childForFieldName("object");
    if (subject?.type !== "member_expression") continue;
    const field = subject.childForFieldName("property")?.text;
    const holder = subject.childForFieldName("object");
    const cls = classOf(n);
    const className = cls && nameOfClass(cls);
    const line = n.startPosition.row + 1;
    const fn = innermost(functions, line);
    if (!field || !className || !fn) continue;
    let via: string | null | undefined;
    if (holder?.type === "this") via = undefined;
    else if (holder?.type === "member_expression" && holder.childForFieldName("object")?.type === "this") via = holder.childForFieldName("property")?.text ?? null;
    else if (holder?.type === "identifier" && (inConstructor(n) || (cls && localsOf(cls).has(holder.text)))) via = holder.text;
    else continue;
    if (via === null || (via !== undefined && !typed(className, via))) continue;
    if (via === undefined && !subjects.has(`${className}.${field}`)) continue;
    (out.nexts ??= []).push({ function: fn, class: className, field, ...(via ? { via } : {}), line });
  }
  const declared = new Set(functions.map((f) => f.name));
  const facts = reactiveCellsOf(tree);
  for (const l of facts.subjectListens ?? []) {
    const name = facts.held.get(l.callback.id);
    const cls = nameOfClass(l.cls);
    if (!name || !cls || !declared.has(name)) continue;
    (out.listens ??= []).push({ function: name, class: cls, field: l.field, via: l.via, line: l.at.startPosition.row + 1 });
  }
  if (!out.subjects && !out.listens && !out.nexts) return null;
  if (Object.keys(types).length > 0) out.types = types;
  return out;
}

/** A listener a click on the emitting side never reaches in production. */
const TEST_OR_STORY = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|e2e|cypress)\/|\.(?:spec|test|stories|story)\.[cm]?[jt]sx?$/;

/**
 * An RxJS subject a service holds, joined across classes: a `.next(x)` — in the service itself (its own
 * method), or through a service another class holds (`this.leagueSvc.changes$.next(c)`) — runs the callbacks
 * subscribed to that subject on a service of the SAME class (`this.leagueSvc.changes$.pipe(…).subscribe(cb)`),
 * the type read from each side's constructor parameter, typed field or `inject(T)` and resolved through
 * the file's imports. A same-named subject of another service class, and a listener in the class that
 * declares the subject, are not joined (the latter is the single-class reader's, `rxjs-subjects.ts`).
 * One INFERRED link per next-site function and listening function.
 */
export class JsSubjectResolver implements DispatchResolver {
  readonly id = "subject";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 35;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const withFlows = analyses.filter((a) => a.subjectFlows);
    if (withFlows.length === 0 || !withFlows.some((a) => a.subjectFlows!.listens?.length)) return [];
    const filePathMap = buildFilePathMap(analyses);
    const byPath = new Map(analyses.map((a) => [a.filePath, a]));
    /** The file declaring the class a file's member names, with the class's name there. */
    const serviceOf = (a: FileAnalysis, cls: string, via: string): { file: string; type: string } | null => {
      const written = a.subjectFlows?.types?.[cls]?.[via];
      if (!written) return null;
      const imp = a.imports.find((i) => i.specifiers.includes(written) && !i.isType);
      if (!imp) return a.subjectFlows?.subjects?.some((s) => s.class === written) ? { file: a.filePath, type: written } : null;
      const file = resolveTarget(imp.source, a.filePath, filePathMap);
      const type = imp.aliases?.[written] ?? written;
      return file && byPath.has(file) ? { file, type } : null;
    };
    /** The subject a member of a service class is: its own, or the one an `asObservable` member exposes. */
    const subjectKey = (file: string, type: string, field: string, depth = 0): string | null => {
      const a = byPath.get(file);
      const s = a?.subjectFlows?.subjects?.find((x) => x.class === type && x.field === field && !(x.via === undefined && x.observes === field));
      if (!a || !s || depth > 6) return null;
      if (s.observes === undefined) return `${file}\0${type}\0${s.field}`;
      if (s.via !== undefined) {
        const service = serviceOf(a, type, s.via);
        return service ? subjectKey(service.file, service.type, s.observes, depth + 1) : null;
      }
      return subjectKey(file, type, s.observes, depth + 1);
    };
    const lineOf = (a: FileAnalysis, symbol: string): number | undefined => {
      const fn = a.functions.find((f) => f.name === symbol);
      if (fn) return fn.line;
      for (const c of a.classes) for (const m of c.methods) if (`${c.name}.${m.name}` === symbol) return m.line;
      return undefined;
    };

    const listeners = new Map<string, Array<{ file: string; symbol: string; line: number; cls: string; test: boolean }>>();
    for (const a of withFlows) {
      for (const l of a.subjectFlows!.listens ?? []) {
        const service = serviceOf(a, l.class, l.via);
        const key = service && subjectKey(service.file, service.type, l.field);
        const line = lineOf(a, l.function);
        if (!key || line === undefined) continue;
        const list = listeners.get(key) ?? listeners.set(key, []).get(key)!;
        if (!list.some((x) => x.file === a.filePath && x.symbol === l.function)) list.push({ file: a.filePath, symbol: l.function, line, cls: l.class, test: TEST_OR_STORY.test(a.filePath) });
      }
    }
    if (listeners.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    for (const a of withFlows) {
      const test = TEST_OR_STORY.test(a.filePath);
      for (const n of a.subjectFlows!.nexts ?? []) {
        const service = n.via ? serviceOf(a, n.class, n.via) : { file: a.filePath, type: n.class };
        const key = service && subjectKey(service.file, service.type, n.field);
        if (!key) continue;
        for (const l of (listeners.get(key) ?? []).filter((x) => test || !x.test).slice(0, 8)) {
          if (l.file === a.filePath && (l.symbol === n.function || (!n.via && l.cls === n.class))) continue;
          const id = `${a.filePath}\0${n.function}\0${l.file}\0${l.symbol}`;
          if (seen.has(id)) continue;
          seen.add(id);
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: n.function,
            sourceLine: n.line,
            callName: `${n.field}.next`,
            targetFile: l.file,
            targetSymbol: l.symbol,
            targetLine: l.line,
            confidence: "INFERRED",
          });
        }
      }
    }
    return links;
  }
}
