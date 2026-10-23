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
    if (listeners.size === 0) return [];

    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const emit = (file: string, symbol: string, line: number, type: string, callName: string): void => {
      for (const l of listeners.get(type) ?? []) {
        if (l.file === file && l.symbol === symbol) continue;
        const key = `${file}\0${symbol}\0${l.file}\0${l.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ sourceFile: file, sourceSymbol: symbol, sourceLine: line, callName, targetFile: l.file, targetSymbol: l.symbol, targetLine: l.line, resolvedBy: "text", confidence: "INFERRED", relation: "dispatch" });
      }
    };
    const scan = (file: string, symbol: string, fn: FunctionInfo): void => {
      let dispatcher: string | null = null;
      for (const c of fn.calls) {
        const stat = STATIC_DISPATCH.exec(c.name);
        if (stat && listeners.has(stat[1]!)) emit(file, symbol, c.line, stat[1]!, c.name);
        if (!dispatcher && DISPATCHER_CALL.test(c.name)) dispatcher = c.name;
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
