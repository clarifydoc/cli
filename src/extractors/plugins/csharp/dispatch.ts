import type {
  ClassInfo,
  FileAnalysis,
  FunctionInfo,
  Language,
  SymbolLink,
} from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * MediatR (CQRS) dispatch resolver for C#.
 *
 * The whole pattern is indirection: a controller action runs
 *   `_mediator.Send(new GetOwnersQuery(...))`
 * and the work lives in a *separate* class
 *   `class GetOwnersQueryHandler : IRequestHandler<GetOwnersQuery, …> { Task Handle(GetOwnersQuery r, …) }`.
 * There is no call edge between them — `Send` resolves to the external
 * `ISender` interface, and `Handle` is never called by name. So the generic
 * linker leaves route→handler→DB severed at the mediator.
 *
 * This resolver reconnects them: it indexes every `IRequestHandler<T>` /
 * `INotificationHandler<T>` / `IStreamRequestHandler<T>` by its request type `T`,
 * then for each callable that dispatches through a mediator emits a synthetic
 * `caller → Handler.Handle` link for every request type it constructs
 * (`new T(...)`) or forwards as a parameter (`Send(command)`).
 */

/** MediatR handler interfaces — capture the FIRST generic arg (the request/notification type). */
const HANDLER_IFACE_RE = /\bI(?:Request|Notification|StreamRequest)Handler\s*<\s*([^,>]+)/;
/** Mediator dispatch method leaf names (ISender / IMediator / IPublisher). */
const DISPATCH_METHODS = new Set(["Send", "SendAsync", "Publish", "PublishAsync"]);
/** Handler entry-point method names. */
const HANDLE_METHODS = new Set(["Handle", "HandleAsync"]);
/** A dispatch call's receiver must look like an injected mediator (avoids `socket.Send`). */
const MEDIATOR_RECEIVER_RE = /mediat|sender|publish|bus/i;

interface HandlerDef {
  file: string;
  /** `ClassName.Handle` — matches the symbol form buildSymbolLinks uses for methods. */
  symbol: string;
  line: number;
}

export class CSharpMediatrResolver implements DispatchResolver {
  readonly id = "mediatr";
  readonly languages: Language[] = ["csharp"];
  readonly priority = 10;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const classes = new Map<string, Array<{ cls: ClassInfo; file: string }>>();
    for (const a of analyses) {
      for (const cls of a.classes) {
        const list = classes.get(cls.name) ?? [];
        list.push({ cls, file: a.filePath });
        classes.set(cls.name, list);
      }
    }
    // 1) request type → handler's Handle method.
    const handlers = new Map<string, HandlerDef>();
    for (const a of analyses) {
      for (const cls of a.classes) {
        const reqType = handledRequestType(cls, classes);
        if (!reqType) continue;
        const handle = handleMethod(cls, a.filePath, classes);
        if (!handle) continue;
        // MediatR allows one handler per request; first definition wins.
        if (!handlers.has(reqType)) handlers.set(reqType, handle);
      }
    }
    if (handlers.size === 0) return [];

    // 2) link each dispatching callable to the handler(s) it triggers.
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const emit = (sourceFile: string, sourceSymbol: string, sourceLine: number, reqType: string): void => {
      const h = handlers.get(reqType);
      if (!h) return;
      if (h.file === sourceFile && h.symbol === sourceSymbol) return; // never self-link
      const key = `${sourceFile}::${sourceSymbol}::${h.file}::${h.symbol}`;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({
        sourceFile,
        sourceSymbol,
        sourceLine,
        callName: `Send(${reqType})`,
        targetFile: h.file,
        targetSymbol: h.symbol,
        targetLine: h.line,
        confidence: "INFERRED",
      });
    };

    // A request built by a method that states its type
    // (`Send(request.ToCreateCommand())`): name → the request types it returns.
    const returns = new Map<string, Set<string>>();
    const noteReturn = (fn: FunctionInfo): void => {
      if (!fn.returnType) return;
      const t = bareType(fn.returnType);
      if (!handlers.has(t)) return;
      const set = returns.get(fn.name) ?? new Set<string>();
      set.add(t);
      returns.set(fn.name, set);
    };
    for (const a of analyses) {
      a.functions.forEach(noteReturn);
      for (const cls of a.classes) cls.methods.forEach(noteReturn);
    }

    for (const a of analyses) {
      for (const fn of a.functions) {
        collectDispatch(a.filePath, fn.name, fn, handlers, returns, emit);
      }
      for (const cls of a.classes) {
        for (const m of cls.methods) {
          collectDispatch(a.filePath, `${cls.name}.${m.name}`, m, handlers, returns, emit);
        }
      }
    }
    return links;
  }
}

type ClassIndex = Map<string, Array<{ cls: ClassInfo; file: string }>>;

/**
 * The request/notification type a class handles, from an `I…Handler<T,…>`
 * base — its own, or one a generic base class states with a type parameter
 * the class fills in (`class GetV2Handler : GetHandler<GetV2Query>` over
 * `abstract class GetHandler<T> : IRequestHandler<T, …>`).
 */
function handledRequestType(cls: ClassInfo, classes: ClassIndex): string | null {
  let current = cls;
  let subst = new Map<string, string>();
  for (let depth = 0; depth < 5; depth++) {
    // C# can't syntactically tell a class base from an interface, so the handler
    // interface may land in `extends` or `implements` — check both.
    const bases = [current.extends, ...(current.implements ?? [])].filter(Boolean) as string[];
    for (const b of bases) {
      const m = HANDLER_IFACE_RE.exec(b);
      if (!m) continue;
      const written = m[1]!.trim();
      // Still a type parameter (of the base, or passed through from the class
      // itself): a generic handler, which handles no one request type.
      if (!subst.has(written) && current.typeParameters?.includes(written)) return null;
      const t = bareType(subst.get(written) ?? written);
      return cls.typeParameters?.includes(t) ? null : t;
    }
    const base = baseClass(current, classes);
    if (!base) return null;
    subst = base.subst(subst);
    current = base.cls;
  }
  return null;
}

/** The Handle method a handler runs: its own, else the nearest base class's. */
function handleMethod(cls: ClassInfo, file: string, classes: ClassIndex): HandlerDef | null {
  let current = cls;
  let currentFile = file;
  for (let depth = 0; depth < 5; depth++) {
    const handle = current.methods.find((m) => HANDLE_METHODS.has(m.name));
    if (handle) return { file: currentFile, symbol: `${current.name}.${handle.name}`, line: handle.line };
    const base = baseClass(current, classes);
    if (!base) return null;
    current = base.cls;
    currentFile = base.file;
  }
  return null;
}

/**
 * The generic class `cls` extends, when exactly one class of that name and
 * arity is in the analysis, with how its type parameters map to what `cls`
 * passes (`subst` composes the mapping already in force below it).
 */
function baseClass(
  cls: ClassInfo,
  classes: ClassIndex,
): { cls: ClassInfo; file: string; subst: (inner: Map<string, string>) => Map<string, string> } | null {
  const written = cls.extends;
  if (!written) return null;
  const m = /^([\w.]+)\s*(?:<(.*)>)?\s*$/.exec(written.trim());
  if (!m) return null;
  const name = m[1]!.slice(m[1]!.lastIndexOf(".") + 1);
  const args = m[2] ? splitTypeArgs(m[2]) : [];
  const found = (classes.get(name) ?? []).filter((c) => (c.cls.typeParameters?.length ?? 0) === args.length && c.cls !== cls);
  if (found.length !== 1) return null;
  const params = found[0]!.cls.typeParameters ?? [];
  return {
    ...found[0]!,
    subst: (inner) => new Map(params.map((p, i) => [p, inner.get(args[i]!) ?? args[i]!] as [string, string])),
  };
}

/** `A, IEnumerable<B, C>, D` → its three top-level arguments. */
function splitTypeArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Emit links for one callable, if it dispatches through a mediator. */
function collectDispatch(
  file: string,
  symbol: string,
  fn: FunctionInfo,
  handlers: Map<string, HandlerDef>,
  returns: Map<string, Set<string>>,
  emit: (f: string, s: string, line: number, reqType: string) => void,
): void {
  let dispatchLine = 0;
  for (const c of fn.calls) {
    const parts = c.name.split(".");
    const leaf = parts[parts.length - 1] ?? "";
    if (!DISPATCH_METHODS.has(leaf)) continue;
    const receiver = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
    if (receiver === "" || MEDIATOR_RECEIVER_RE.test(receiver)) {
      if (dispatchLine === 0) dispatchLine = c.line;
    }
  }
  if (dispatchLine === 0) return; // not a mediator dispatch site

  // (a) request types constructed inline: `new GetOwnersQuery(...)`.
  for (const c of fn.calls) {
    const m = /^new\s+([A-Za-z_][\w.]*)/.exec(c.name);
    if (!m) continue;
    const t = bareType(m[1]!);
    if (handlers.has(t)) emit(file, symbol, c.line || dispatchLine, t);
  }
  // (b) request types a called method states it returns, when its name
  //     returns only one: `Send(request.ToCreateCommand())`.
  for (const c of fn.calls) {
    const leaf = c.name.slice(c.name.lastIndexOf(".") + 1);
    const types = returns.get(leaf);
    if (types?.size === 1) emit(file, symbol, c.line || dispatchLine, [...types][0]!);
  }
  // (c) request types forwarded as a parameter: `Send(command)` where the
  //     enclosing method declares `CreateOwnerCommand command`.
  for (const p of fn.params ?? []) {
    if (!p.type) continue;
    const t = bareType(p.type);
    if (handlers.has(t)) emit(file, symbol, fn.line || dispatchLine, t);
  }
}

/** Strip generics / nullable / array / namespace → bare identifier. */
function bareType(type: string): string {
  let t = type.trim().replace(/\?+$/, "").replace(/\[\]$/, "").replace(/<.*$/, "");
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  return t.trim();
}
