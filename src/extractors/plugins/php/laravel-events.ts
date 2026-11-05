import type { ClassInfo, FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Laravel events reach their listeners through the dispatcher, never by a call:
 *
 *   event(new MatchPlayed($match));            // also broadcast(…), Event::dispatch(…)
 *   MatchPlayed::dispatch($match);             // an event using `Dispatchable`
 *   class UpdateLeagueTable { public function handle(MatchPlayed $event) { … } }
 *
 * A listener is a class whose `handle` (or `__invoke`) takes the event type —
 * how Laravel discovers listeners, and how the listeners an `$listen` map
 * names are written too. Each callable that dispatches an event type links to
 * every listener of it. A type nothing dispatches, or that no listener
 * handles, links nothing — so a middleware's `handle(Request $request)` never
 * becomes a listener.
 */

const LISTENER_METHODS = new Set(["handle", "__invoke"]);
/** Dispatcher calls that take the event object: `event(…)`, `broadcast(…)`, `Event::dispatch(…)`. */
const DISPATCHER_CALL = /^(?:event|broadcast|Event\.(?:dispatch|until)|this\.events\.dispatch|this\.dispatcher\.dispatch)$/;
/** `MatchPlayed::dispatch(…)` and its conditional forms. */
const STATIC_DISPATCH = /^([A-Z][\w]*)\.(?:dispatch|dispatchIf|dispatchUnless|broadcast)$/;

interface ListenerDef {
  file: string;
  symbol: string;
  line: number;
}

/** `dispatch(new SettleFee(…))`, `dispatch_sync(…)`, `Bus::dispatch(…)` — the queue helpers that take the job object. */
const JOB_DISPATCH_CALL = /^(?:dispatch|dispatch_sync|dispatch_now|Bus\.(?:dispatch|dispatchSync|dispatchNow|chain|batch))$/;

/**
 * A queued job runs its `handle` when dispatched: the classes with a `handle`
 * method, by name — a name two classes share is no job we can name.
 */
function jobHandlers(analyses: FileAnalysis[]): Map<string, ListenerDef[]> {
  const byName = new Map<string, Array<{ file: string; cls: ClassInfo }>>();
  for (const a of analyses) for (const cls of a.classes as ClassInfo[]) (byName.get(cls.name) ?? byName.set(cls.name, []).get(cls.name)!).push({ file: a.filePath, cls });
  const out = new Map<string, ListenerDef[]>();
  for (const [name, defs] of byName) {
    if (defs.length !== 1) continue;
    const m = defs[0]!.cls.methods.find((x) => x.name === "handle");
    if (m) out.set(name, [{ file: defs[0]!.file, symbol: `${name}.handle`, line: m.line }]);
  }
  return out;
}

const bareType = (t: string): string => t.replace(/^\?/, "").replace(/^\\?(?:[\w]+\\)*/, "").trim();

export class LaravelEventResolver implements DispatchResolver {
  readonly id = "laravel-events";
  readonly languages: Language[] = ["php"];
  readonly priority = 12;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const listeners = new Map<string, ListenerDef[]>();
    for (const a of analyses) {
      for (const cls of a.classes) {
        for (const m of cls.methods) {
          if (!LISTENER_METHODS.has(m.name)) continue;
          const type = m.params[0]?.type;
          if (!type) continue;
          for (const t of type.split("|").map(bareType)) {
            if (!/^[A-Z]/.test(t)) continue;
            (listeners.get(t) ?? listeners.set(t, []).get(t)!).push({ file: a.filePath, symbol: `${cls.name}.${m.name}`, line: m.line });
          }
        }
      }
    }
    const jobs = jobHandlers(analyses);
    if (listeners.size === 0 && jobs.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const emit = (file: string, symbol: string, line: number, type: string, callName: string, table: Map<string, ListenerDef[]> = listeners): void => {
      for (const l of table.get(type) ?? []) {
        if (l.file === file && l.symbol === symbol) continue;
        const key = `${file}\0${symbol}\0${l.file}\0${l.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ sourceFile: file, sourceSymbol: symbol, sourceLine: line, callName, targetFile: l.file, targetSymbol: l.symbol, targetLine: l.line, resolvedBy: "text", confidence: "INFERRED", relation: "dispatch" });
      }
    };
    const scan = (file: string, symbol: string, fn: FunctionInfo): void => {
      let dispatcher: string | null = null;
      let jobDispatcher: string | null = null;
      for (const c of fn.calls) {
        const stat = STATIC_DISPATCH.exec(c.name);
        if (stat && listeners.has(stat[1]!)) emit(file, symbol, c.line, stat[1]!, c.name);
        if (stat && jobs.has(stat[1]!)) emit(file, symbol, c.line, stat[1]!, c.name, jobs);
        if (!dispatcher && DISPATCHER_CALL.test(c.name)) dispatcher = c.name;
        if (JOB_DISPATCH_CALL.test(c.name)) jobDispatcher ??= c.name;
      }
      if (jobDispatcher) {
        for (const c of fn.calls) {
          const m = /^new\s+\\?([\w\\]+)/.exec(c.name);
          const type = m ? bareType(m[1]!) : null;
          if (type && jobs.has(type)) emit(file, symbol, c.line, type, `${jobDispatcher}(${type})`, jobs);
        }
      }
      if (!dispatcher) return;
      // The event objects this callable builds are the ones it hands the dispatcher.
      for (const c of fn.calls) {
        const m = /^new\s+\\?([\w\\]+)/.exec(c.name);
        const type = m ? bareType(m[1]!) : null;
        if (type && listeners.has(type)) emit(file, symbol, c.line, type, `${dispatcher}(${type})`);
      }
    };
    for (const a of analyses) {
      for (const fn of a.functions) scan(a.filePath, fn.name, fn);
      for (const cls of a.classes as ClassInfo[]) for (const m of cls.methods) scan(a.filePath, `${cls.name}.${m.name}`, m);
    }
    return links;
  }
}
