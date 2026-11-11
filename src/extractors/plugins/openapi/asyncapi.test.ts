import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { DataAccessEdge, DataAccessNode, ProjectAnalysis } from "../../../types/analysis.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { analyze } from "../../../core/analyzer.js";
import { brokerOfProtocol, extractAsyncApi, isAsyncApiDocument } from "./asyncapi.js";
import { isOpenApiDocument } from "./meta.js";

const V2_KAFKA = `asyncapi: '2.6.0'
info:
  title: League events
  version: 1.0.0
servers:
  main:
    url: kafka.example.com:9092
    protocol: kafka
channels:
  league.club.signed:
    subscribe:
      message:
        $ref: '#/components/messages/ClubSigned'
  league.player.retired:
    subscribe:
      message:
        name: PlayerRetired
        payload:
          type: object
          properties:
            playerId: { type: string }
components:
  messages:
    ClubSigned:
      payload:
        $ref: '#/components/schemas/ClubSignedPayload'
  schemas:
    ClubSignedPayload:
      type: object
      required: [clubId]
      properties:
        clubId: { type: string }
        fee: { type: integer }
`;

const V3_AMQP = `asyncapi: 3.0.0
info:
  title: Transfers
  version: 1.0.0
servers:
  broker:
    host: rabbit.example.com
    protocol: amqp
channels:
  playerTransferred:
    address: player.transferred
    messages:
      PlayerTransferred:
        payload:
          type: object
          properties:
            playerId: { type: string }
            toClub: { type: string }
  clubSigned:
    address: league.club.signed
    messages:
      ClubSigned:
        payload:
          type: object
          properties:
            clubId: { type: string }
operations:
  onPlayerTransferred:
    action: receive
    channel:
      $ref: '#/channels/playerTransferred'
  sendClubSigned:
    action: send
    channel:
      $ref: '#/channels/clubSigned'
`;

const OPENAPI = `openapi: 3.0.1
info:
  title: Players API
paths:
  /players:
    get:
      operationId: listPlayers
`;

describe("AsyncAPI sniff", () => {
  it("claims AsyncAPI documents, never OpenAPI ones", () => {
    expect(isAsyncApiDocument(V2_KAFKA)).toBe(true);
    expect(isAsyncApiDocument(V3_AMQP)).toBe(true);
    expect(isAsyncApiDocument('{ "asyncapi": "2.6.0", "channels": {} }')).toBe(true);
    expect(isAsyncApiDocument(OPENAPI)).toBe(false);
    expect(isOpenApiDocument(V2_KAFKA)).toBe(false);
  });
  it("names brokers the way code does", () => {
    expect(brokerOfProtocol("kafka-secure")).toBe("kafka");
    expect(brokerOfProtocol("amqps")).toBe("amqp");
    expect(brokerOfProtocol("secure-mqtt")).toBe("mqtt");
  });
});

describe("AsyncAPI contracts on the data-access graph", () => {
  const root = mkdtempSync(join(tmpdir(), "clarifydoc-asyncapi-src-"));
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-asyncapi-out-"));
  afterAll(() => {
    for (const dir of [root, out]) rmSync(dir, { recursive: true, force: true });
  });
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("package.json", JSON.stringify({ name: "league", dependencies: { kafkajs: "2", amqplib: "0.10" } }));
  write("docs/club-events.asyncapi.yaml", V2_KAFKA);
  write("docs/transfers.asyncapi.yaml", V3_AMQP);
  write("docs/players.openapi.yaml", OPENAPI);
  write("docs/events.asyncapi.json", JSON.stringify({ asyncapi: "2.6.0", servers: { s: { protocol: "mqtt", url: "x" } }, channels: { "club/{clubId}/signed": { subscribe: { message: { name: "ClubSigned" } } } } }));
  write("docs/holes.asyncapi.json", JSON.stringify({ asyncapi: "2.6.0", servers: { k: { protocol: "kafka", url: "x" } }, channels: { "club.{clubId}.signed": { subscribe: { message: { name: "ClubSigned" } } }, "club.{clubId}.retired": { subscribe: { message: { name: "ClubRetired" } } } } }));
  write("src/holes.ts", "export async function announce(producer: any, id: string) {\n  await producer.send({ topic: `club.${id}.signed`, messages: [] });\n}\n");
  write("src/publisher.ts", "export async function announce(producer: any) {\n  await producer.send({ topic: 'league.club.signed', messages: [] });\n}\n");
  write("src/consumer.ts", "export async function listen(ch: any) {\n  await ch.consume('player.transferred', () => {});\n}\n");

  const queues = async () => {
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const result = await loadReportSummary(out);
    const nodes: DataAccessNode[] = (result.dataAccessGraph?.nodes ?? []).filter((n) => n.kind === "queue");
    return { result, nodes };
  };

  it("joins the contract's destinations to the code's, per broker", async () => {
    const { nodes, result } = await queues();
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const kafka = byId.get("queue::kafka::league.club.signed");
    expect(kafka?.contract).toBe(true);
    expect(kafka?.unimplemented).toBeUndefined(); // the producer meets it

    const amqp = byId.get("queue::amqp::player.transferred");
    expect(amqp?.contract).toBe(true);
    expect(amqp?.unimplemented).toBeUndefined(); // the consumer meets it (broker inferred from the one that uses the name)

    // The same address on another broker is a different destination, stated by the contract alone.
    const decoy = byId.get("queue::amqp::league.club.signed");
    expect(decoy?.contract).toBe(true);
    expect(decoy?.unimplemented).toBe(true);

    // A channel nothing implements is visible.
    expect(byId.get("queue::kafka::league.player.retired")?.unimplemented).toBe(true);
    // MQTT topic: a channel parameter is a one-level wildcard.
    expect(byId.get("queue::mqtt::club/+/signed")?.contract).toBe(true);

    const edges: DataAccessEdge[] = result.dataAccessGraph?.edges ?? [];
    expect(edges.some((e) => e.source === "file::src/publisher.ts" && e.target === "queue::kafka::league.club.signed")).toBe(true);
    // A contract document neither sends nor receives: it marks the queue nodes and draws no edge of its own.
    expect(edges.filter((e) => /asyncapi/.test(e.source) || /asyncapi/.test(e.target))).toEqual([]);
  });

  it("meets a channel parameter and the code's templated destination on one node", async () => {
    const { nodes } = await queues();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const signed = byId.get("queue::kafka::club.*.signed");
    expect(signed?.contract).toBe(true);
    expect(signed?.unimplemented).toBeUndefined();
    expect(byId.get("queue::kafka::club.*.retired")?.unimplemented).toBe(true);
    expect(byId.has("queue::kafka::club.{clubId}.signed")).toBe(false);
    expect(byId.has("queue::amqp::club.*.signed")).toBe(false);
  });

  it("states its rows apart from the code's, with the direction each operation names", async () => {
    // 2.x `subscribe` is what the application sends; 3.x `receive` what it consumes.
    const kafka = extractAsyncApi(V2_KAFKA.split("\n")).dataSources.find((d) => d.target === "league.club.signed");
    expect(kafka?.kind).toBe("queue-publish");
    const amqp = extractAsyncApi(V3_AMQP.split("\n")).dataSources.find((d) => d.target === "player.transferred");
    expect(amqp?.kind).toBe("queue-consume");
    const { result } = await queues();
    const entries = (result.entryPoints ?? []).map((e: { filePath?: string }) => e.filePath ?? "");
    expect(entries.filter((p: string) => /asyncapi/.test(p))).toEqual([]);
  });

  it("reads payloads as classes and leaves OpenAPI rows alone", async () => {
    const { result } = await queues();
    const names = extractAsyncApi(V2_KAFKA.split("\n")).classes.map((c) => c.name).sort();
    expect(names).toEqual(["ClubSignedPayload", "PlayerRetired"]);
    const routes = (result.routeMap ?? []).filter((r) => r.filePath === "docs/players.openapi.yaml");
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /players"]);
  });
});
