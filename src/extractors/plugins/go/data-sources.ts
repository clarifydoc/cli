import type { DataSourceInfo } from "../../../types/analysis.js";
import { argValue, callArgs, consumeDestination, publishDestination } from "./mq-destinations.js";
import { stringConstants } from "./routes.js";
import { dbAccessFor, dbVerbTable } from "../shared/db-access.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { extractXormDataSources } from "./xorm.js";


/** A destination named by a constant or variable: `Topic`, `kafka.Topic`. */
const NAME_REF_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/;
/**
 * Go data sources — raw SQL (database/sql, sqlx, pgx), GORM, HTTP clients,
 * env reads and message queues. Go had NO data-source extraction at all, so
 * a handler's `db.Query("SELECT ... FROM users")` never reached the ER model
 * and every Go trace dead-ended at the handler.
 *
 * Raw SQL rides the shared SQL-in-strings scanner. Go's idiomatic multi-line
 * SQL uses backtick raw literals, which the scanner (double-quote based)
 * cannot see — {@link normalizeRawStrings} rewrites each backtick span into
 * per-line double-quoted fragments first (line numbers are preserved, inner
 * quotes escaped), which is exactly the C-style adjacent-literal shape the
 * scanner already concatenates.
 */

/** Rewrite backtick raw strings into per-line `"..."` fragments. */
export function normalizeRawStrings(text: string): string {
  let out = "";
  let i = 0;
  let inRaw = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (!inRaw) {
      if (ch === "`") {
        inRaw = true;
        out += '"';
      } else {
        out += ch;
        // Skip over regular string literals so a `"`+"`"-containing string
        // can't toggle raw mode.
        if (ch === '"') {
          let j = i + 1;
          while (j < text.length && text[j] !== '"') {
            out += text[j]!;
            if (text[j] === "\\") { out += text[j + 1] ?? ""; j++; }
            j++;
          }
          out += '"';
          i = j;
        }
      }
    } else {
      if (ch === "`") {
        inRaw = false;
        out += '"';
      } else if (ch === "\n") {
        out += '"\n"';
      } else if (ch === '"') {
        out += '\\"';
      } else {
        out += ch;
      }
    }
    i++;
  }
  return out;
}

/** `db.Find(&users)` etc. — GORM verbs, gated on a DB-shaped receiver. */
const GORM_RE = /\b(\w*(?:db|DB|tx|orm|conn)\w*)\.\s*(Find|First|Take|Last|Create|Save|Update|Updates|Delete|Preload|Model)\s*\(\s*&?(\w+)/;
/** Struct-literal entity on the line: `&User{}` / `Model(&User{})`. */
/** GORM: `Preload`/`Model` only build the chain, so they stay unclassified. */
const GORM_ACCESS = dbVerbTable(
  ["Find", "First", "Take", "Last"],
  ["Create", "Save", "Update", "Updates", "Delete"],
);

/** Also package-qualified: `&entity.Password{}`. */
const STRUCT_ENTITY_RE = /&(?:[a-z_]\w*\.)?([A-Z]\w*)\s*\{/;

/** `http.Get("url")` / `http.PostForm(...)` — stdlib client helpers. */
const HTTP_HELPER_RE = /\bhttp\.(Get|Post|PostForm|Head)\s*\(\s*(?:["'`]([^"'`]+)["'`])?/;
/** `http.NewRequest("GET", url, ...)` / `http.NewRequestWithContext(ctx, http.MethodGet, url, ...)`. */
// `NewRequestWithContext(ctx, …)` / `(r.Context(), …)`: the context comes first.
const NEW_REQUEST_RE = /http\.NewRequest(?:WithContext\s*\(\s*[\w.]+(?:\(\s*\))?\s*,|\s*\()\s*(?:["'`](GET|POST|PUT|PATCH|DELETE|HEAD)["'`]|http\.Method(Get|Post|Put|Patch|Delete|Head))\s*,\s*(?:["'`]([^"'`]+)["'`])?/;
/** `client.Get("url")` — any *client-named receiver with an HTTP verb. */
const CLIENT_VERB_RE = /\b(\w*[Cc]lient)\.\s*(Get|Post|Put|Patch|Delete|Head)\s*\(\s*(?:["'`]([^"'`]+)["'`])?/;

/** An import of a cache or key-value store client, whose Get/Delete are no HTTP requests. */
const KV_CLIENT_IMPORT_RE = /"[^"]*(?:\/go-redis\/|redis\/go-redis|gomodule\/redigo|\/gomemcache\/|\/memcache"|\/bigcache|\/groupcache|\/etcd\/client|hashicorp\/consul\/api|\/ristretto|\/badger)[^"]*"/;

const ENV_RE = /\bos\.(Getenv|LookupEnv)\s*\(\s*["'`]([^"'`]+)["'`]/;

/** MQ publish/consume — generic verbs gated on a broker-shaped receiver. */
const MQ_RECEIVER_RE = /^(ch(an(nel)?)?|amqp\w*|nats\w*|nc|js|producer|writer|pub\w*|sub\w*|consumer|reader|kafka\w*)$/i;
const MQ_PUBLISH_RE = /\b(\w+)\.\s*(Publish|PublishWithContext|PublishMsg|WriteMessages|SendMessage)\s*\(/;
const MQ_CONSUME_RE = /\b(\w+)\.\s*(Consume|Subscribe|QueueSubscribe|ChanSubscribe|ReadMessage|FetchMessage|ReceiveMessage)\s*\(/;
const FIRST_STRING_RE = /["'`]([^"'`]+)["'`]/;
/**
 * An in-process event bus keyed by the event's type: `events.Dispatch(&TaskCreatedEvent{…})`,
 * `events.DispatchOnCommit(s, &x.TaskCreatedEvent{…})` publish the type they build;
 * `events.RegisterListener((&TaskCreatedEvent{}).Name(), &SendNotification{})` subscribes a
 * listener type, whose `Handle` method is what runs.
 */
const EVENT_DISPATCH_RE = /\b(?:events?|eventBus|bus|dispatcher)\.\s*(Dispatch|DispatchOnCommit|DispatchAsync|Emit|Fire)\s*\(/;
const EVENT_LISTEN_RE = /\b(?:events?|eventBus|bus|dispatcher)\.\s*(RegisterListener|AddListener|Listen|On)\s*\(/;
/** The event built as the call's first or second argument: `&TaskCreatedEvent{`, `s, &models.X{`. */
const EVENT_LITERAL_RE = /^\s*(?:\w+\s*,\s*)?&?(?:\w+\.)?([A-Z]\w*)\s*\{/;
/** `(&TaskCreatedEvent{}).Name()`, `models.TaskCreatedEvent{}.Name()`. */
const EVENT_NAME_ARG_RE = /^\(?\s*&?(?:\w+\.)?([A-Z]\w*)\s*\{\s*\}\s*\)?\s*\.\s*Name\s*\(\s*\)$/;
/** `&SendNotification{}`, `&x.Listener{wsEvent: "…"}`. */
const LISTENER_ARG_RE = /^&?(?:\w+\.)?([A-Z]\w*)\s*\{/;

/**
 * A URL argument built by concatenation (`cs.shippingAddr+"/get-quote"`), read
 * up to the argument's end: literals as written, anything else as a `${…}`
 * hole. Null when no part is a literal.
 */
function concatUrl(rest: string): string | null {
  let depth = 0;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "(") depth++;
    else if (c === ")" && depth-- === 0) { end = i; break; }
    else if (c === "," && depth === 0) { end = i; break; }
  }
  const parts = rest.slice(0, end).split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.some((p) => /^["`]/.test(p))) return null;
  return parts.map((p) => (/^["`]/.test(p) ? p.slice(1, -1) : `\${${p}}`)).join("");
}

export function extractGoDataSources(lines: string[]): DataSourceInfo[] {
  // Raw SQL first (multi-line aware), then per-line pattern scans.
  const normLines = normalizeRawStrings(lines.join("\n")).split("\n");
  const sources: DataSourceInfo[] = extractSqlStringDataSources(normLines);
  let constants: Map<string, string> | undefined;
  let kvClient: boolean | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const lineNo = i + 1;

    const gorm = line.match(GORM_RE);
    if (gorm) {
      const entity = line.match(STRUCT_ENTITY_RE)?.[1];
      sources.push({
        kind: "database",
        name: `GORM: ${gorm[2]}`,
        target: entity ?? gorm[3]!,
        ...(entity ? { entity } : {}),
        ...(() => {
          const a = dbAccessFor(gorm[2]!, GORM_ACCESS);
          return a ? { access: a } : {};
        })(),
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const helper = line.match(HTTP_HELPER_RE);
    const newReq = helper ? null : line.match(NEW_REQUEST_RE);
    let clientVerb = helper || newReq ? null : line.match(CLIENT_VERB_RE);
    // A cache or key-value client shares the verbs: `c.client.Get(key)` (memcache), `client.Get(ctx, key)`
    // (redis) — with no URL literal, a context first or a file using such a client says it is no request.
    if (clientVerb && !clientVerb[3]) {
      const first = /^\s*([\w.]+)/.exec(line.slice(clientVerb.index! + clientVerb[0].length))?.[1] ?? "";
      kvClient ??= lines.some((l) => KV_CLIENT_IMPORT_RE.test(l));
      if (/^(?:ctx|c|context\.\w+)$/.test(first) || kvClient) clientVerb = null;
    }
    if (helper) {
      sources.push({ kind: "api-call", name: helper[1]!.toUpperCase().replace("POSTFORM", "POST"), target: helper[2] ?? null, calls: [], line: lineNo });
      continue;
    }
    if (newReq) {
      const target = newReq[3] ?? concatUrl(line.slice(newReq.index! + newReq[0].length));
      sources.push({ kind: "api-call", name: (newReq[1] ?? newReq[2]!).toUpperCase(), target, calls: [], line: lineNo });
      continue;
    }
    if (clientVerb) {
      sources.push({ kind: "api-call", name: clientVerb[2]!.toUpperCase(), target: clientVerb[3] ?? null, calls: [], line: lineNo });
      continue;
    }

    // sarama: a `ProducerMessage{ Topic: … }` is what the producer sends — the publish names its topic.
    if (/\bsarama\.ProducerMessage\s*\{/.test(line)) {
      let topic: string | null = null;
      let ref: string | undefined;
      for (let k = i; k < Math.min(lines.length, i + 12) && topic === null; k++) {
        const t = /\bTopic\s*:\s*(?:"([^"]+)"|([\w.]+))/.exec(lines[k]!);
        if (t?.[1] !== undefined) topic = t[1];
        else if (t) {
          // A name: this file's constant, else another file's or package's (`kafka.Topic`) for the project pass.
          const local = (constants ??= stringConstants(lines)).get(t[2]!);
          topic = local ?? t[2]!;
          if (local === undefined) ref = t[2]!;
        }
        if (k > i && /^\s*\}/.test(lines[k]!)) break;
      }
      sources.push({ kind: "queue-publish", name: "MQ: sarama ProducerMessage", target: topic, ...(ref ? { targetRef: ref } : {}), calls: [], line: lineNo });
      continue;
    }

    const env = line.match(ENV_RE);
    if (env) {
      sources.push({ kind: "env", name: `os.${env[1]}`, target: env[2]!, calls: [], line: lineNo });
      continue;
    }

    const dispatch = EVENT_DISPATCH_RE.exec(line);
    if (dispatch) {
      const after = [line.slice(dispatch.index + dispatch[0].length), lines[i + 1] ?? ""].join(" ");
      const type = EVENT_LITERAL_RE.exec(after)?.[1];
      if (type) {
        sources.push({ kind: "queue-publish", name: `Event: ${dispatch[1]}`, target: type, entity: type, calls: [], line: lineNo });
        continue;
      }
    }
    const listen = EVENT_LISTEN_RE.exec(line);
    if (listen) {
      const args = callArgs(lines, i, listen.index + listen[0].length - 1);
      const type = EVENT_NAME_ARG_RE.exec(args[0] ?? "")?.[1];
      const listener = LISTENER_ARG_RE.exec(args[1] ?? "")?.[1];
      // Only a listener whose `Handle` this file declares: that method is the consumer.
      const declares = listener && new RegExp(String.raw`^func\s*\(\s*\w*\s*\*?${listener}\s*\)\s*Handle\s*\(`, "m").test(lines.join("\n"));
      if (type && declares) {
        sources.push({ kind: "queue-consume", name: `Event: ${listen[1]}`, target: type, entity: type, handler: `${listener}.Handle`, calls: [], line: lineNo });
        continue;
      }
    }

    // A destination argument that is a name the file does not define: the project pass looks it up.
    let ref: string | undefined;
    const value = (a: string | undefined): string | null => {
      const v = argValue(a, constants ??= stringConstants(lines), lines, i);
      if (v === null && a !== undefined && NAME_REF_RE.test(a.trim())) ref = a.trim();
      return v;
    };
    const pub = line.match(MQ_PUBLISH_RE);
    if (pub && MQ_RECEIVER_RE.test(pub[1]!)) {
      const stated = publishDestination(pub[2]!, callArgs(lines, i, pub.index! + pub[0].length - 1), value);
      sources.push({
        kind: "queue-publish",
        name: `MQ: ${pub[2]}`,
        target: stated !== undefined ? stated : line.slice(line.indexOf(pub[2]!)).match(FIRST_STRING_RE)?.[1] ?? null,
        ...(stated === null && ref ? { targetRef: ref } : {}),
        calls: [],
        line: lineNo,
      });
      continue;
    }
    const con = line.match(MQ_CONSUME_RE);
    if (con && MQ_RECEIVER_RE.test(con[1]!)) {
      const stated = consumeDestination(con[2]!, callArgs(lines, i, con.index! + con[0].length - 1), value);
      sources.push({
        kind: "queue-consume",
        name: `MQ: ${con[2]}`,
        target: stated !== undefined ? stated : line.slice(line.indexOf(con[2]!)).match(FIRST_STRING_RE)?.[1] ?? null,
        ...(stated === null && ref ? { targetRef: ref } : {}),
        calls: [],
        line: lineNo,
      });
    }
  }

  // xorm sessions (gitea): the entity is the terminal verb's argument (xorm.ts).
  const gormLines = new Set(sources.filter((d) => d.name.startsWith("GORM:")).map((d) => d.line));
  for (const d of extractXormDataSources(lines)) if (!gormLines.has(d.line)) sources.push(d);

  return sources;
}
