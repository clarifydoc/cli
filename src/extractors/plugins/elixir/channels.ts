import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * Phoenix Channels as message channels, named by event the way Socket.IO's
 * are: the JS client's `channel.push("new_goal", …)` reaches the channel's
 * `def handle_in("new_goal", payload, socket)`, and the channel's
 * `broadcast!(socket, "goal_scored", …)` / `push(socket, …)` reaches the
 * client's `channel.on("goal_scored", …)`. So a channel module's
 * `handle_in("evt")` clause consumes `evt` (what it writes is that consumer's),
 * `handle_out("evt")` consumes an intercepted broadcast, and its `push` /
 * `broadcast` / `broadcast_from` publish. `Endpoint.broadcast(topic, "evt", …)`
 * publishes from anywhere. Only literal events: an event built at runtime has
 * nothing to meet.
 */

/** `use Phoenix.Channel`, or the app's `use LeagueWeb, :channel`. */
const CHANNEL_MODULE_RE = /^\s*use\s+(?:Phoenix\.Channel\b|[A-Z][\w.]*\s*,\s*:channel\b)/;
const HANDLER_RE = /^\s*def\s+(handle_in|handle_out)\s*\(\s*"([^"#\\]+)"\s*,/;
/** `push(socket, "evt", …)`, `broadcast!(socket, "evt", …)`, `Phoenix.Channel.broadcast_from(socket, "evt", …)`. */
const CHANNEL_SEND_RE = /(?:^|[^\w.:])(?:Phoenix\.Channel\.)?(push|broadcast!?|broadcast_from!?)\s*\(\s*[a-z_]\w*\s*,\s*"([^"#\\]+)"/g;
/** `socket |> push("evt", …)` / `|> broadcast!("evt", …)`. */
const PIPED_SEND_RE = /\|>\s*(?:Phoenix\.Channel\.)?(push|broadcast!?|broadcast_from!?)\s*\(\s*"([^"#\\]+)"/g;
/** `LeagueWeb.Endpoint.broadcast("match:1", "goal_scored", payload)`: topic, then event. */
const ENDPOINT_SEND_RE = /\b(?:[A-Z]\w*\.)*Endpoint\.(broadcast!?|local_broadcast|broadcast_from!?|local_broadcast_from)\s*\(([^\n]*)/g;

/** `def join("match:" <> _id, _payload, socket)` / `def join("lobby", …)`: the topic the clause accepts. */
const JOIN_RE = /^\s*def\s+join\s*\(\s*([^,]+?)\s*,/;

/**
 * A topic as written → the pattern it names: `"lobby"` → `lobby`, `"match:" <> id`
 * and `"match:#{id}"` → `match:*`; null when it is not one of those.
 */
export function topicPattern(written: string): string | null {
  const w = written.trim();
  let m = /^"([^"#\\]*)"$/.exec(w);
  if (m) return m[1]!;
  m = /^"([^"#\\]+)"\s*<>\s*[a-z_]\w*$/.exec(w) ?? /^"([^"#\\]+)#\{[^}]*\}"$/.exec(w);
  return m ? `${m[1]}*` : null;
}

/** The channel events a file's channel modules handle and send, and its endpoint broadcasts. */
export function phoenixChannelEvents(lines: string[]): DataSourceInfo[] {
  const text = lines.join("\n");
  const channelFile = lines.some((l) => CHANNEL_MODULE_RE.test(l));
  if (!channelFile && !/Endpoint\.(?:local_)?broadcast/.test(text)) return [];
  // The topic the channel is joined on, when its `join` clauses name exactly one —
  // what its handlers hear and its pushes and broadcasts go out on.
  const joined = channelFile ? new Set(lines.map((l) => JOIN_RE.exec(l)?.[1]).filter((t): t is string => !!t).map((t) => topicPattern(t))) : new Set<string | null>();
  const channelTopic = joined.size === 1 ? [...joined][0] ?? null : null;
  const out: DataSourceInfo[] = [];
  const add = (kind: DataSourceInfo["kind"], verb: string, event: string, line: number, topic: string | null): void => {
    // `phx_join`, `phx_reply`…: the protocol's own messages.
    if (event.startsWith("phx_")) return;
    out.push({ kind, name: `Phoenix.Channel: ${verb}`, target: event, ...(topic ? { topic } : {}), calls: [], line });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const code = line.replace(/(^|\s)#.*$/, "$1");
    if (!code.trim()) continue;
    if (channelFile) {
      const h = HANDLER_RE.exec(code);
      if (h) add("queue-consume", h[1]!, h[2]!, i + 1, channelTopic);
      for (const m of code.matchAll(CHANNEL_SEND_RE)) add("queue-publish", m[1]!, m[2]!, i + 1, channelTopic);
      for (const m of code.matchAll(PIPED_SEND_RE)) add("queue-publish", m[1]!, m[2]!, i + 1, channelTopic);
    }
    for (const m of code.matchAll(ENDPOINT_SEND_RE)) {
      // `broadcast_from(pid, topic, event, msg)` names its topic second and its event third.
      const args = topLevelArgs(m[2]!);
      const from = /_from/.test(m[1]!) ? 1 : 0;
      const event = args[from + 1] && /^"([^"#\\]+)"$/.exec(args[from + 1]!)?.[1];
      if (event) add("queue-publish", `Endpoint.${m[1]}`, event, i + 1, args[from] ? topicPattern(args[from]!) : null);
    }
  }
  return out;
}

/** A call's arguments up to its closing paren, split at top-level commas (strings and their `#{}` kept whole). */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let interp = 0;
  let cur = "";
  for (let k = 0; k < args.length; k++) {
    const ch = args[k]!;
    if (quote) {
      if (ch === "\\") { cur += ch + (args[++k] ?? ""); continue; }
      if (ch === '"' && interp === 0) quote = false;
      else if (ch === "{" && args[k - 1] === "#") interp++;
      else if (ch === "}" && interp > 0) interp--;
      cur += ch;
      continue;
    }
    if (ch === '"') quote = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Whether the file declares a channel module, whose `handle_in` clauses are one handler per event. */
export function isChannelModule(lines: readonly string[]): boolean {
  return lines.some((l) => CHANNEL_MODULE_RE.test(l));
}
