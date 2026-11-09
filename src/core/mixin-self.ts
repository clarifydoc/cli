import type { DataSourceInfo, FileAnalysis, SymbolLink } from "../types/analysis.js";
import { innermostAt, SELF_CALL, spansOf } from "./api-route-symbol-links.js";

/**
 * A mixin's access on its own receiver:
 *
 *     module Labelled                     # included by Club and by Player
 *       def relabel(labels) = update!(labels: labels)
 *     end
 *
 *     club.relabel(["derby"])             # writes clubs — never players
 *
 * The row in the mixin (`DataSourceInfo.mixinSelf`, no entity) is the table of
 * whichever class the method runs on, and only a call site says which. For
 * every resolved call into a function holding such a row (a link at least
 * INFERRED) whose receiver the linker typed — the class the method was found
 * on (`SymbolLink.viaType`, captured by `captureMixinReceivers` before it is
 * dropped) — this adds a row of the same access at the call site naming that
 * class, when the project declares it an entity. A call on the caller's own
 * instance from a class that is no entity (another method of the mixin, a
 * mixin including it) hands the rows on to the caller, to be bound where it is
 * called. A call whose receiver is untyped, or typed as a class that is no
 * entity, binds nothing: the table is never guessed from the mixin's
 * includers. In memory only; per-file JSON is untouched.
 *
 * Returns the number of rows added.
 */
export function bindMixinSelfAccess(
  analyses: readonly FileAnalysis[],
  links: readonly SymbolLink[],
  receivers: ReadonlyMap<string, ReadonlyArray<MixinReceiver>>,
): number {
  type Held = { row: DataSourceInfo; verb: string };
  const held = new Map<string, Held[]>();
  for (const a of analyses) {
    const rows = (a.dataSources ?? []).filter((d) => d.kind === "database" && d.mixinSelf && !d.entity);
    if (rows.length === 0) continue;
    const spans = spansOf(a);
    for (const row of rows) {
      const at = innermostAt(spans, row.line);
      if (!at) continue;
      const key = `${a.filePath}::${at.symbol}`;
      (held.get(key) ?? held.set(key, []).get(key)!).push({ row, verb: row.name.slice(row.name.lastIndexOf(".") + 1) });
    }
  }
  if (held.size === 0) return 0;

  // Classes the project declares as entities, by bare name.
  const entities = new Set<string>();
  for (const a of analyses) {
    for (const c of a.classes ?? []) {
      const d = c.decorators ?? [];
      if (d.includes("entity") || d.includes("table")) entities.add(leafOf(c.name));
    }
  }

  const callers = new Map<string, SymbolLink[]>();
  for (const l of links) {
    if (l.confidence === "AMBIGUOUS" || l.navigational || (l.relation && l.relation !== "calls")) continue;
    const k = `${l.targetFile}::${l.targetSymbol}`;
    (callers.get(k) ?? callers.set(k, []).get(k)!).push(l);
  }
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const classOf = (symbol: string): string | null => {
    const dot = symbol.lastIndexOf(".");
    return dot > 0 && !symbol.startsWith("route:") ? symbol.slice(0, dot) : null;
  };

  let added = 0;
  const queue = [...held.keys()];
  const handedOn = new Set<string>();
  for (let qi = 0; qi < queue.length && qi < 10_000; qi++) {
    const target = queue[qi]!;
    const rows = held.get(target)!;
    const targetClass = classOf(target.slice(target.indexOf("::") + 2));
    const doneEdges = new Set<string>();
    for (const l of callers.get(target) ?? []) {
      const edge = receiverKey(l);
      if (doneEdges.has(edge)) continue;
      doneEdges.add(edge);
      const caller = byFile.get(l.sourceFile);
      if (!caller) continue;
      const callerClass = classOf(l.sourceSymbol);
      const typed = receivers.get(edge);
      // No type stated: a call between two methods of one class is on that instance.
      const sites: MixinReceiver[] = typed?.length
        ? [...typed]
        : callerClass && callerClass === targetClass && l.sourceFile === l.targetFile && onSelf(l.callName) ? [{ type: callerClass, file: l.sourceFile, line: l.sourceLine }] : [];
      for (const site of sites) {
        const model = leafOf(site.type);
        if (entities.has(model)) {
          for (const { row, verb } of rows) {
            const name = `${site.type}.${verb}`;
            const handler = l.sourceSymbol.startsWith("route:") ? l.sourceSymbol : undefined;
            if (caller.dataSources.some((d) => d.kind === "database" && d.line === site.line && d.entity === model && d.access === row.access && d.name === name && d.handler === handler)) continue;
            const { mixinSelf: _mixin, ...rest } = row;
            caller.dataSources.push({
              ...rest,
              name,
              entity: model,
              line: site.line,
              calls: [],
              // A route's own call (a handler a module serves, typed per route): the route's access.
              ...(handler ? { handler } : {}),
            });
            added++;
          }
        } else if (site.type === callerClass && site.file === l.sourceFile) {
          // On the caller's own instance, in a class that is no entity: the caller's call site binds it.
          const key = `${l.sourceFile}::${l.sourceSymbol}`;
          const list = held.get(key) ?? held.set(key, []).get(key)!;
          let grew = false;
          for (const h of rows) {
            const id = `${key}\0${h.row.mixinSelf}\0${h.verb}\0${h.row.access ?? ""}`;
            if (handedOn.has(id) || list.some((x) => x.row === h.row)) continue;
            handedOn.add(id);
            list.push(h);
            grew = true;
          }
          if (grew) queue.push(key);
        }
      }
    }
  }
  return added;
}

/** The class a resolved call's receiver was typed as, and the call's line. */
export interface MixinReceiver {
  type: string;
  file: string;
  line: number;
}

/**
 * The receiver class of every link that says one (`SymbolLink.viaType`: the
 * method was found on a base or a mixin of that class), keyed by caller and
 * callee — taken before the in-memory field is dropped, for
 * `bindMixinSelfAccess`.
 */
export function captureMixinReceivers(links: readonly SymbolLink[]): Map<string, MixinReceiver[]> {
  const out = new Map<string, MixinReceiver[]>();
  for (const l of links) {
    if (!l.viaType || !l.viaTypeFile) continue;
    const k = receiverKey(l);
    const list = out.get(k) ?? out.set(k, []).get(k)!;
    if (!list.some((r) => r.type === l.viaType && r.file === l.viaTypeFile)) list.push({ type: l.viaType, file: l.viaTypeFile, line: l.sourceLine });
  }
  return out;
}

/** A bare call, or one on the instance itself (`self.x`, `this.x`). */
const onSelf = (callName: string): boolean => !/[.:>]/.test(callName.replace(/\(.*$/s, "")) || SELF_CALL.test(callName);
const receiverKey = (l: SymbolLink): string => `${l.sourceFile}::${l.sourceSymbol}\0${l.targetFile}::${l.targetSymbol}`;
const leafOf = (name: string): string => name.split(/\.|::/).pop()!;
