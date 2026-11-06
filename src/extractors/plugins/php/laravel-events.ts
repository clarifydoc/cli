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

interface JobDef extends ListenerDef {
  /** The class's namespace-qualified name, `App\\Jobs\\SyncClub`, or the bare name when the file declares no namespace. */
  fqn: string;
}

const nsOf = (a: FileAnalysis): string => (a.declaredNamespace ?? "").replace(/^\\/, "");

/** A queued job runs its `handle` when dispatched: the classes with a `handle` method, by leaf name. */
function jobHandlers(analyses: FileAnalysis[]): Map<string, JobDef[]> {
  const out = new Map<string, JobDef[]>();
  for (const a of analyses) {
    const ns = nsOf(a);
    for (const cls of a.classes as ClassInfo[]) {
      const m = cls.methods.find((x) => x.name === "handle");
      if (!m) continue;
      (out.get(cls.name) ?? out.set(cls.name, []).get(cls.name)!).push({ file: a.filePath, symbol: `${cls.name}.handle`, line: m.line, fqn: ns ? `${ns}\\${cls.name}` : cls.name });
    }
  }
  return out;
}

/**
 * The job a name written in `file` stands for: the class its `use` import or its own namespace says
 * (`new \\App\\Jobs\\SyncClub`, `new Jobs\\SyncClub` under a `use App\\Jobs`), never the leaf name alone
 * when two classes share it. A name no namespace fact places is a job only when ONE class bears it,
 * the file imports none of that name and declares no namespace of its own.
 */
function jobFor(a: FileAnalysis, written: string, defs: JobDef[] | undefined): JobDef | undefined {
  if (!defs || defs.length === 0) return undefined;
  const ns = nsOf(a);
  const name = written.replace(/^\\/, "");
  const head = name.split("\\")[0]!;
  const rest = name.slice(head.length);
  const imp = a.imports.find((i) => i.specifiers.includes(head) && !i.executes);
  let fqn: string;
  if (written.startsWith("\\")) fqn = name;
  else if (imp) fqn = imp.source.replace(/^\\/, "") + rest;
  else fqn = ns ? `${ns}\\${name}` : name;
  const exact = defs.filter((d) => d.fqn.toLowerCase() === fqn.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  if (defs.length === 1 && !imp && !ns && !written.includes("\\")) return defs[0];
  return undefined;
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
    const emit = (file: string, symbol: string, line: number, type: string, callName: string, targets: ListenerDef[] = listeners.get(type) ?? []): void => {
      for (const l of targets) {
        if (l.file === file && l.symbol === symbol) continue;
        const key = `${file}\0${symbol}\0${l.file}\0${l.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ sourceFile: file, sourceSymbol: symbol, sourceLine: line, callName, targetFile: l.file, targetSymbol: l.symbol, targetLine: l.line, resolvedBy: "text", confidence: "INFERRED", relation: "dispatch" });
      }
    };
    const scan = (a: FileAnalysis, symbol: string, fn: FunctionInfo): void => {
      const file = a.filePath;
      let dispatcher: string | null = null;
      let jobDispatcher: string | null = null;
      for (const c of fn.calls) {
        const stat = STATIC_DISPATCH.exec(c.name);
        if (stat && listeners.has(stat[1]!)) emit(file, symbol, c.line, stat[1]!, c.name);
        const job = stat ? jobFor(a, stat[1]!, jobs.get(stat[1]!)) : undefined;
        if (stat && job) emit(file, symbol, c.line, stat[1]!, c.name, [job]);
        if (!dispatcher && DISPATCHER_CALL.test(c.name)) dispatcher = c.name;
        if (JOB_DISPATCH_CALL.test(c.name)) jobDispatcher ??= c.name;
      }
      if (jobDispatcher) {
        for (const c of fn.calls) {
          const m = /^new\s+(\\?[\w\\]+)/.exec(c.name);
          const type = m ? bareType(m[1]!) : null;
          const job = m && type ? jobFor(a, m[1]!, jobs.get(type)) : undefined;
          if (type && job) emit(file, symbol, c.line, type, `${jobDispatcher}(${type})`, [job]);
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
      for (const fn of a.functions) scan(a, fn.name, fn);
      for (const cls of a.classes as ClassInfo[]) for (const m of cls.methods) scan(a, `${cls.name}.${m.name}`, m);
    }
    return links;
  }
}
