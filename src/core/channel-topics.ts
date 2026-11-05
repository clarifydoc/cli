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

/** Whether an MQTT topic filter (`league/+/score`, `league/#`, `$share/g/league/#`) covers a topic name. */
export function mqttFilterMatches(filter: string, topic: string): boolean {
  const f = filter.replace(/^\$share\/[^/]+\//, "").split("/");
  const t = topic.split("/");
  // A topic of the broker's own (`$SYS/…`) is never reached by a filter starting with a wildcard.
  if (topic.startsWith("$") && (f[0] === "+" || f[0] === "#")) return false;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/**
 * MQTT filters meet the topics they cover: the data-access graph joins publish and consume rows by `target`, so a
 * publish on `league/premier/score` never met the subscriber of `league/+/score`. Each publish row of an MQTT
 * topic (`DataSourceInfo.topicSyntax`) is repeated at every wildcard filter some file subscribes with that covers
 * it; the row on its own topic stays. Only rows marked `mqtt` take part — any other bus joins exactly. In memory
 * only. Returns the number of rows added.
 */
export function joinMqttTopicFilters(analyses: readonly FileAnalysis[]): number {
  const filters = new Set<string>();
  for (const a of analyses) {
    for (const row of a.dataSources ?? []) {
      if (row.topicSyntax === "mqtt" && row.kind === "queue-consume" && row.target && /[+#]/.test(row.target)) filters.add(row.target);
    }
  }
  if (filters.size === 0) return 0;
  let added = 0;
  for (const a of analyses) {
    const extra: DataSourceInfo[] = [];
    for (const row of a.dataSources ?? []) {
      if (row.topicSyntax !== "mqtt" || row.kind !== "queue-publish" || !row.target || /[+#]/.test(row.target)) continue;
      for (const filter of filters) {
        if (mqttFilterMatches(filter, row.target) && !a.dataSources.some((d) => d.kind === row.kind && d.target === filter && d.line === row.line)) extra.push({ ...row, target: filter });
      }
    }
    a.dataSources.push(...extra);
    added += extra.length;
  }
  return added;
}
