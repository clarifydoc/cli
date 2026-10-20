import type { FileAnalysis, SecurityIssue, SymbolLink } from "../types/analysis.js";

/**
 * Request input followed into a function another file declares.
 *
 * Each file's taint pass (`plugins/shared/handler-taint.ts`) leaves two kinds
 * of facts (`FileAnalysis.taintFacts`): its handlers' calls into functions it
 * does not declare, with the arguments that carry request input, and for each
 * of its other functions, which parameters reach a sink. Here a call meets the
 * function it reaches — the one symbol link from that call — and an argument
 * meets the parameter at its position: a finding at the sink in the other
 * file, its steps running through both (the caller's carry their file).
 * One file hop; a call the linker resolves to several functions is skipped.
 */
export function crossFileTaint(analyses: readonly FileAnalysis[], symbolLinks: readonly SymbolLink[]): SecurityIssue[] {
  const summaries = new Map<string, NonNullable<FileAnalysis["taintFacts"]>["summaries"]>();
  for (const a of analyses) if (a.taintFacts?.summaries.length) summaries.set(a.filePath, a.taintFacts.summaries);
  if (summaries.size === 0) return [];
  const linksAt = new Map<string, SymbolLink[]>();
  for (const l of symbolLinks) {
    if (!summaries.has(l.targetFile)) continue;
    const key = `${l.sourceFile}\u0000${l.sourceLine}`;
    (linksAt.get(key) ?? linksAt.set(key, []).get(key)!).push(l);
  }
  const leaf = (name: string) => name.split(/[.:>\\#]+/).pop() ?? name;

  const out: SecurityIssue[] = [];
  const seen = new Set<string>();
  for (const a of analyses) {
    for (const call of a.taintFacts?.calls ?? []) {
      const links = (linksAt.get(`${a.filePath}\u0000${call.line}`) ?? []).filter((l) => leaf(l.callName) === leaf(call.callee));
      const targets = new Set(links.map((l) => `${l.targetFile}\u0000${l.targetLine}`));
      if (targets.size !== 1) continue;
      const link = links[0]!;
      if (link.targetFile === a.filePath) continue; // the file's own pass followed it
      const fn = summaries.get(link.targetFile)!.find((s) => s.name === leaf(link.targetSymbol) && Math.abs(s.line - link.targetLine) <= 3);
      if (!fn) continue;
      for (const arg of call.args) {
        for (const sink of fn.sinks) {
          if (sink.param !== arg.index) continue;
          const key = `${link.targetFile}\u0000${sink.line}\u0000${sink.category}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            category: sink.category,
            severity: "high",
            message: `Request input from ${a.filePath}:${arg.from} reaches ${sink.what} of ${sink.callee}() unsanitized, passed in through ${call.callee}().`,
            filePath: link.targetFile,
            line: sink.line,
            snippet: `${sink.callee}(…)`,
            ...(sink.cwe ? { cwe: sink.cwe } : {}),
            flow: [
              ...arg.path.map((s) => ({ ...s, file: a.filePath })),
              { line: call.line, note: `passed to ${call.callee}() as argument ${arg.index + 1}`, file: a.filePath },
              ...sink.path,
            ],
          });
        }
      }
    }
  }
  return out;
}
