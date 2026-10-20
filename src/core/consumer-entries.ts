import type { EntryPointInfo, FileAnalysis, SymbolDataAccess } from "../types/analysis.js";

/**
 * Message consumers as entry points: a function that takes messages off a
 * queue or topic (`SymbolDataAccess.access === "queue-consume"` — a BullMQ
 * worker, a Celery task, a Kafka listener, a Socket.IO handler) is run by the
 * broker, not called by anything in the code. As an entry point it starts its
 * own data flows ("consumer of emails → writes sent_emails") and anchors what
 * it reaches. Language-agnostic: every plugin that reports a consumer gets
 * these. One per consuming function and queue, nearest the analysis order.
 */
export function consumerEntryPoints(
  access: readonly SymbolDataAccess[],
  analyses: readonly Pick<FileAnalysis, "filePath" | "projectId">[],
  existing: ReadonlyArray<EntryPointInfo & { filePath: string }> = [],
): Array<EntryPointInfo & { filePath: string; projectId?: string }> {
  const projectOf = new Map(analyses.map((a) => [a.filePath, a.projectId]));
  const taken = new Set(existing.map((e) => `${e.filePath}\u0000${e.handler ?? ""}\u0000${e.name}`));
  const out: Array<EntryPointInfo & { filePath: string; projectId?: string }> = [];
  for (const d of access) {
    if (d.access !== "queue-consume" || !d.entity) continue;
    const key = `${d.file}\u0000${d.symbol}\u0000${d.entity}`;
    if (taken.has(key)) continue;
    taken.add(key);
    const projectId = projectOf.get(d.file);
    out.push({
      kind: "message-consumer",
      name: d.entity,
      handler: d.symbol,
      line: d.symbolLine,
      filePath: d.file,
      ...(d.datastore && d.datastore !== d.entity ? { framework: d.datastore } : {}),
      ...(projectId ? { projectId } : {}),
    });
  }
  return out;
}
