import type { DataSourceInfo, FileAnalysis } from "../types/analysis.js";

/**
 * Events sent within a topic (`DataSourceInfo.topic`) meet only where their
 * topics do. The data-access graph joins publish and consume rows by `target`,
 * the event, so a `new_goal` pushed on `match:1` would also reach the
 * `new_goal` handler of the `lobby` channel. When the rows of one event state
 * more than one topic, each row that states one is retargeted to
 * `<event>@<topic>` — a literal topic (`match:1`) taking the one pattern it
 * falls under (`match:*`) — and a row that states none is repeated for each of
 * those topics, so it keeps meeting them all. One topic, or none, leaves the
 * event as it is. In memory only; per-file JSON is untouched.
 *
 * Returns the number of rows retargeted or added.
 */
export function scopeChannelTopics(analyses: readonly FileAnalysis[]): number {
  let changed = bindChannelTopics(analyses);
  const byEvent = new Map<string, Array<{ a: FileAnalysis; row: DataSourceInfo }>>();
  for (const a of analyses) {
    for (const row of a.dataSources ?? []) {
      if ((row.kind !== "queue-publish" && row.kind !== "queue-consume") || !row.target) continue;
      (byEvent.get(row.target) ?? byEvent.set(row.target, []).get(row.target)!).push({ a, row });
    }
  }
  for (const [event, rows] of byEvent) {
    if (!rows.some((r) => r.row.topic)) continue;
    const patterns = [...new Set(rows.map((r) => r.row.topic).filter((t): t is string => !!t && t.endsWith("*")))];
    const keyOf = (topic: string): string => {
      if (topic.endsWith("*")) return topic;
      const under = patterns.filter((p) => topic.startsWith(p.slice(0, -1)));
      return under.length === 1 ? under[0]! : topic;
    };
    const keys = [...new Set(rows.flatMap((r) => (r.row.topic ? [keyOf(r.row.topic)] : [])))];
    if (keys.length < 2) continue;
    for (const { a, row } of rows) {
      if (row.topic) {
        row.target = `${event}@${keyOf(row.topic)}`;
        changed++;
        continue;
      }
      row.target = `${event}@${keys[0]}`;
      for (const key of keys.slice(1)) {
        a.dataSources.push({ ...row, target: `${event}@${key}` });
        changed++;
      }
    }
  }
  return changed;
}

/**
 * A channel module whose code states no topic takes the one a socket binds it
 * to (`FileAnalysis.channelBindings`): the module is the class the binding
 * names — by its full name, or by its last segment when one class has it.
 * Only the rows the plugin marked (`topicFromBinding`) are given the topic, and
 * only when the module is bound to exactly one.
 */
function bindChannelTopics(analyses: readonly FileAnalysis[]): number {
  const bindings = analyses.flatMap((a) => a.channelBindings ?? []);
  if (bindings.length === 0) return 0;
  const owners = new Map<string, FileAnalysis[]>();
  for (const a of analyses) {
    if (!a.dataSources?.some((d) => d.topicFromBinding)) continue;
    for (const c of a.classes ?? []) {
      for (const key of [c.name, c.name.slice(c.name.lastIndexOf(".") + 1)]) {
        const list = owners.get(key) ?? owners.set(key, []).get(key)!;
        if (!list.includes(a)) list.push(a);
      }
    }
  }
  const topicsOf = new Map<FileAnalysis, Set<string>>();
  for (const b of bindings) {
    const files = owners.get(b.module) ?? (b.module.includes(".") ? owners.get(b.module.slice(b.module.lastIndexOf(".") + 1)) : undefined);
    if (files?.length !== 1) continue;
    (topicsOf.get(files[0]!) ?? topicsOf.set(files[0]!, new Set()).get(files[0]!)!).add(b.topic);
  }
  let changed = 0;
  for (const [a, topics] of topicsOf) {
    if (topics.size !== 1) continue;
    const topic = [...topics][0]!;
    for (const row of a.dataSources) {
      if (!row.topicFromBinding || row.topic) continue;
      row.topic = topic;
      changed++;
    }
  }
  return changed;
}
