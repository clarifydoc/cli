import type { CallInfo, DataSourceInfo, FileAnalysis, FunctionInfo, SymbolLink } from "../types/analysis.js";
import { innermostAt, spansOf } from "./api-route-symbol-links.js";

/**
 * A channel FACTORY publishes (or consumes) on the channel its caller names:
 *
 *     clientSend(event, room, ...data) { this.server.to(room).emit(event, ...data); }
 *     // elsewhere
 *     this.socket.clientSend("match_update", room, match);
 *
 * The factory's own row carries `channelParameter: "event"` and no target; the
 * call site is where the channel is. For every resolved call into such a
 * function whose argument at that parameter's position is a string literal
 * (`CallInfo.args`, quoted as written), this adds a row of the same kind at the
 * call site naming that channel, in the caller's file — so the data-access pass
 * attributes it to the calling function and the broker hop joins it to the
 * consumers of that channel. One level deep: a factory handing its parameter to
 * another factory is not followed. In memory only; per-file JSON is untouched.
 *
 * Returns the number of rows added.
 */
export function expandChannelFactories(analyses: readonly FileAnalysis[], links: readonly SymbolLink[]): number {
  const factories = new Map<string, Array<{ row: DataSourceInfo; index: number }>>();
  for (const a of analyses) {
    const rows = (a.dataSources ?? []).filter((d) => d.channelParameter && !d.target);
    if (rows.length === 0) continue;
    const spans = spansOf(a);
    const fnOf = (symbol: string): FunctionInfo | undefined => {
      const dot = symbol.lastIndexOf(".");
      const method = dot > 0 ? a.classes.find((c) => c.name === symbol.slice(0, dot))?.methods.find((m) => m.name === symbol.slice(dot + 1)) : undefined;
      return method ?? a.functions.find((f) => f.name === symbol);
    };
    for (const row of rows) {
      const at = innermostAt(spans, row.line);
      const index = at ? fnOf(at.symbol)?.params.findIndex((p) => p.name === row.channelParameter) ?? -1 : -1;
      if (!at || index < 0) continue;
      const key = `${a.filePath}::${at.symbol}`;
      (factories.get(key) ?? factories.set(key, []).get(key)!).push({ row, index });
    }
  }
  if (factories.size === 0) return 0;

  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const callsAt = new Map<string, Map<number, CallInfo[]>>();
  const callsOf = (a: FileAnalysis): Map<number, CallInfo[]> => {
    let m = callsAt.get(a.filePath);
    if (!m) {
      m = new Map();
      for (const fn of [...a.functions, ...a.classes.flatMap((c) => c.methods)]) {
        for (const c of fn.calls ?? []) if (c.args) (m.get(c.line) ?? m.set(c.line, []).get(c.line)!).push(c);
      }
      callsAt.set(a.filePath, m);
    }
    return m;
  };
  const leafOf = (name: string) => name.replace(/\(.*$/, "").split(/\.|->|::/).pop()!;

  let added = 0;
  for (const link of links) {
    const rows = factories.get(`${link.targetFile}::${link.targetSymbol}`);
    const caller = rows ? byFile.get(link.sourceFile) : undefined;
    if (!rows || !caller) continue;
    const leaf = leafOf(link.callName);
    const call = callsOf(caller).get(link.sourceLine)?.find((c) => leafOf(c.name) === leaf);
    if (!call?.args) continue;
    for (const { row, index } of rows) {
      const arg = call.args[index] ?? "";
      const channel = /^(['"])([\w.:-]+)\1$/.exec(arg)?.[2];
      if (!channel) continue;
      const exists = caller.dataSources.some((d) => d.kind === row.kind && d.line === link.sourceLine && d.target === channel);
      if (exists) continue;
      caller.dataSources.push({ kind: row.kind, name: row.name, target: channel, line: link.sourceLine, calls: [] });
      added++;
    }
  }
  return added;
}
