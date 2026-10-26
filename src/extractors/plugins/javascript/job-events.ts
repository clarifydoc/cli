import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { JOB_KEY_SEPARATOR } from "./call-hooks.js";

/**
 * A job queued or an event emitted by name, joined to the handlers registered
 * for that name (NestJS-style decorators on service methods):
 *
 *   await this.jobRepository.queue({ name: JobName.Thumbnail, data: { id } });   // key job:JobName.Thumbnail
 *   @OnJob({ name: JobName.Thumbnail, queue: QueueName.Media }) handleThumbnail(…)
 *
 *   this.eventRepository.emit('ClubUpdate', { id });                              // key event:ClubUpdate
 *   @OnEvent({ name: 'ClubUpdate' }) onClubUpdate(…)    or    @OnEvent('ClubUpdate')
 *
 * The caller's key comes from `call-hooks.ts`; each handler of the name gets
 * a link (an event may have several listeners; a job's handler is one).
 */
export class JobEventResolver implements DispatchResolver {
  readonly id = "job-event";
  readonly languages: Language[] = ["typescript", "javascript"];
  readonly priority = 33;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const handlers = new Map<string, Array<{ file: string; symbol: string; line: number }>>();
    for (const a of analyses) {
      for (const c of a.classes) {
        for (const m of c.methods) {
          for (const d of m.decorators) {
            const key = handlerKey(d);
            if (key) (handlers.get(key) ?? handlers.set(key, []).get(key)!).push({ file: a.filePath, symbol: `${c.name}.${m.name}`, line: m.line });
          }
        }
      }
    }
    if (handlers.size === 0) return [];
    const links: SymbolLink[] = [];
    for (const a of analyses) {
      const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      for (const fn of fns) {
        for (const call of fn.calls) {
          // `queueAll` enqueues several jobs: one key each.
          const targets = call.key ? call.key.split(JOB_KEY_SEPARATOR).flatMap((k) => handlers.get(k) ?? []) : undefined;
          for (const h of targets ?? []) {
            links.push({
              sourceFile: a.filePath,
              sourceSymbol: fn.name,
              sourceLine: call.line,
              callName: call.key!.includes(JOB_KEY_SEPARATOR) ? (call.key!.split(JOB_KEY_SEPARATOR).find((k) => handlers.get(k)?.includes(h)) ?? call.key!) : call.key!,
              targetFile: h.file,
              targetSymbol: h.symbol,
              targetLine: h.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    return links;
  }
}

/** `OnJob({ name: JobName.X, … })` → job:JobName.X; `OnEvent({ name: 'X' })` / `OnEvent('X')` → event:X. */
function handlerKey(decorator: string): string | null {
  const job = /^OnJob\s*\(\s*\{[^}]*?\bname\s*:\s*(?:'([^']+)'|"([^"]+)"|([\w$]+\.[\w$]+))/.exec(decorator);
  if (job) return `job:${job[1] ?? job[2] ?? job[3]}`;
  const event = /^OnEvent\s*\(\s*(?:\{[^}]*?\bname\s*:\s*)?(?:'([^']+)'|"([^"]+)")/.exec(decorator);
  return event ? `event:${event[1] ?? event[2]}` : null;
}
