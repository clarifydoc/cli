import type { ClassInfo, DataSourceInfo, EntityRelation } from "../../../types/analysis.js";
import { extractOpenApiEntities, extractOpenApiRelations, parseOpenApiDocument, refName, schemaClass, type SpecNode } from "./index.js";

/**
 * AsyncAPI documents (`asyncapi: 2.x | 3.x`, YAML or JSON) — the contract of a
 * message bus, as OpenAPI is the contract of HTTP. Each channel operation is a
 * `queue-publish` / `queue-consume` row marked `contract`, on the SAME
 * destination (`broker` from the server's protocol, `target` the channel
 * address) that code's rows name, so the data-access graph joins them on one
 * `queue::<broker>::<address>` node; a node only the contract states is
 * `unimplemented`. Message payloads are classes (components' schemas and each
 * message with an inline payload), so the request-schema pass reads them.
 *
 * 2.x speaks from the client's side: `publish` is what the application
 * RECEIVES, `subscribe` what it SENDS. 3.x says it with `action: send|receive`.
 */

const HEAD_YAML_RE = /^asyncapi\s*:\s*["']?\d/m;
const TOP_YAML_RE = /^asyncapi\s*:\s*["']?\d/m;
const JSON_RE = /"asyncapi"\s*:\s*"\d/;

export function isAsyncApiDocument(rawSource: string): boolean {
  const head = rawSource.slice(0, 8192);
  if (/^\s*\{/.test(head)) return JSON_RE.test(head);
  return HEAD_YAML_RE.test(head) || (rawSource.length > head.length && TOP_YAML_RE.test(rawSource));
}

/** An AsyncAPI protocol → the broker name the code extractors use for the same system. */
const BROKER_BY_PROTOCOL: Record<string, string> = {
  kafka: "kafka",
  "kafka-secure": "kafka",
  amqp: "amqp",
  amqps: "amqp",
  mqtt: "mqtt",
  mqtts: "mqtt",
  "secure-mqtt": "mqtt",
  sqs: "sqs",
  sns: "sns",
  redis: "redis",
  nats: "nats",
  jms: "jms",
  stomp: "stomp",
};

export function brokerOfProtocol(protocol: string | null | undefined): string | undefined {
  const p = protocol?.trim().toLowerCase();
  return p ? (BROKER_BY_PROTOCOL[p] ?? p) : undefined;
}

/** A `#/a/b~1c` pointer into the document. */
function pointer(root: SpecNode, ref: string | null | undefined): SpecNode | undefined {
  if (!ref?.startsWith("#/")) return undefined;
  let cur: SpecNode | undefined = root;
  for (const seg of ref.slice(2).split("/")) {
    cur = cur?.children.get(decodeURIComponent(seg).replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!cur) return undefined;
  }
  return cur;
}

/** The node a `$ref` names (followed up to four hops), else the node itself. */
function deref(root: SpecNode, node: SpecNode): SpecNode {
  let cur = node;
  for (let i = 0; i < 4; i++) {
    const target = pointer(root, cur.children.get("$ref")?.value);
    if (!target || target === cur) return cur;
    cur = target;
  }
  return cur;
}

function refKey(node: SpecNode): string | null {
  const ref = node.children.get("$ref")?.value;
  return ref?.startsWith("#/") ? decodeURIComponent(ref.split("/").pop()!).replace(/~1/g, "/") : null;
}

/** `{playerId}` channel parameters stay holes; an MQTT topic spells a one-level hole `+`. */
function addressOf(address: string, broker: string | undefined): string {
  return broker === "mqtt" ? address.replace(/\{[^}]*\}/g, "+") : address;
}

interface Msg {
  /** The message's name (its `name`, else its key under `messages`). */
  name: string | null;
  /** The payload schema's (or class's) name. */
  payload: string | null;
}

function messageOf(root: SpecNode, key: string | null, raw: SpecNode, classes: Map<string, ClassInfo>): Msg {
  const node = deref(root, raw);
  const name = node.children.get("name")?.value ?? node.children.get("messageId")?.value ?? key ?? refKey(raw);
  const payload = node.children.get("payload");
  if (!payload) return { name, payload: null };
  const schemaName = refName(payload.children.get("$ref")?.value);
  if (schemaName) return { name, payload: schemaName };
  const resolved = deref(root, payload);
  if (name && /^[A-Za-z_]\w*$/.test(name) && (resolved.children.has("properties") || resolved.children.has("allOf")) && !classes.has(name)) {
    classes.set(name, schemaClass(name, resolved));
  }
  return { name, payload: name && classes.has(name) ? name : null };
}

/** The messages a `message` node lists (`oneOf` unfolded). */
function messagesIn(root: SpecNode, node: SpecNode | undefined, classes: Map<string, ClassInfo>): Msg[] {
  if (!node) return [];
  const list = node.children.get("oneOf")?.items ?? node.items;
  return list ? list.map((item) => messageOf(root, null, item, classes)) : [messageOf(root, null, node, classes)];
}

export interface AsyncApiFacts {
  classes: ClassInfo[];
  relations: EntityRelation[];
  dataSources: DataSourceInfo[];
}

export function extractAsyncApi(lines: string[]): AsyncApiFacts {
  const root = parseOpenApiDocument(lines);
  const v3 = (root.children.get("asyncapi")?.value ?? "").startsWith("3");
  const brokerOfServer = new Map<string, string | undefined>();
  for (const [name, s] of root.children.get("servers")?.children ?? []) {
    brokerOfServer.set(name, brokerOfProtocol(deref(root, s).children.get("protocol")?.value));
  }
  const classMap = new Map<string, ClassInfo>();
  for (const c of extractOpenApiEntities(lines)) classMap.set(c.name, c);
  // components.messages with an inline payload are classes of their own.
  for (const [key, m] of root.children.get("components")?.children.get("messages")?.children ?? []) messageOf(root, key, m, classMap);

  const rows: DataSourceInfo[] = [];
  const emit = (channel: SpecNode, address: string, direction: "send" | "receive", messages: Msg[], line: number): void => {
    const named = channel.children.get("servers")?.items?.map((s) => s.value ?? refKey(s)).filter((x): x is string => !!x);
    const known = named?.filter((n) => brokerOfServer.has(n));
    const serverNames = known && known.length > 0 ? known : [...brokerOfServer.keys()];
    const brokers = [...new Set(serverNames.map((n) => brokerOfServer.get(n)))];
    if (brokers.length === 0) brokers.push(undefined);
    const list: Msg[] = messages.length > 0 ? messages : [{ name: null, payload: null }];
    for (const broker of brokers) {
      for (const msg of list) {
        const entity = msg.payload ?? msg.name ?? undefined;
        rows.push({
          kind: direction === "send" ? "queue-publish" : "queue-consume",
          name: `AsyncAPI: ${direction}`,
          target: addressOf(address, broker),
          calls: [],
          line,
          fromContract: true,
          ...(broker ? { broker } : {}),
          ...(entity ? { entity } : {}),
          ...(broker === "mqtt" ? { topicSyntax: "mqtt" as const } : {}),
        });
      }
    }
  };

  if (v3) {
    for (const [, op] of root.children.get("operations")?.children ?? []) {
      const opNode = deref(root, op);
      const action = opNode.children.get("action")?.value;
      const channelRef = opNode.children.get("channel");
      if ((action !== "send" && action !== "receive") || !channelRef) continue;
      const channel = deref(root, channelRef);
      const address = channel.children.get("address")?.value ?? refKey(channelRef);
      if (!address || address === "null") continue;
      const own = opNode.children.get("messages");
      const msgs = own?.items
        ? own.items.map((m) => messageOf(root, null, m, classMap))
        : [...(channel.children.get("messages")?.children ?? [])].map(([k, m]) => messageOf(root, k, m, classMap));
      emit(channel, address, action, msgs, op.line);
    }
  } else {
    for (const [address, raw] of root.children.get("channels")?.children ?? []) {
      const channel = deref(root, raw);
      for (const [verb, direction] of [["publish", "receive"], ["subscribe", "send"]] as const) {
        const op = channel.children.get(verb);
        if (op) emit(channel, address, direction, messagesIn(root, deref(root, op).children.get("message"), classMap), op.line);
      }
    }
  }

  const classes = [...classMap.values()];
  return { classes, relations: extractOpenApiRelations(lines, classes), dataSources: rows };
}
