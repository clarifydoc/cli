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
  readonly languages: Language[] = ["csharp"];
  readonly priority = 10;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    // 1) request type → handler's Handle method.
    const handlers = new Map<string, HandlerDef>();
    for (const a of analyses) {
      for (const cls of a.classes) {
        const reqType = handledRequestType(cls);
        if (!reqType) continue;
        const handle = cls.methods.find((m) => HANDLE_METHODS.has(m.name));
        if (!handle) continue;
        // MediatR allows one handler per request; first definition wins.
        if (!handlers.has(reqType)) {
          handlers.set(reqType, {
            file: a.filePath,
            symbol: `${cls.name}.${handle.name}`,
            line: handle.line,
          });
        }
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

    for (const a of analyses) {
      for (const fn of a.functions) {
        collectDispatch(a.filePath, fn.name, fn, handlers, emit);
      }
      for (const cls of a.classes) {
        for (const m of cls.methods) {
          collectDispatch(a.filePath, `${cls.name}.${m.name}`, m, handlers, emit);
        }
      }
    }
    return links;
  }
}

/** The request/notification type a class handles, from an `I…Handler<T,…>` base. */
function handledRequestType(cls: ClassInfo): string | null {
  // C# can't syntactically tell a class base from an interface, so the handler
  // interface may land in `extends` or `implements` — check both.
  const bases = [cls.extends, ...(cls.implements ?? [])].filter(Boolean) as string[];
  for (const b of bases) {
    const m = HANDLER_IFACE_RE.exec(b);
    if (m) return bareType(m[1]!);
  }
  return null;
}

/** Emit links for one callable, if it dispatches through a mediator. */
function collectDispatch(
  file: string,
  symbol: string,
  fn: FunctionInfo,
  handlers: Map<string, HandlerDef>,
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
  // (b) request types forwarded as a parameter: `Send(command)` where the
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
