import { describe, it, expect } from "vitest";
import { attributeDataAccessToSymbols, buildDataAccessGraph } from "./data-access-graph.js";
import { synthesizeQueueSymbolLinks } from "./api-route-symbol-links.js";
import type { DataSourceInfo, FileAnalysis } from "../types/analysis.js";

const row = (extra: Partial<DataSourceInfo>): DataSourceInfo => ({ kind: "queue-publish", name: "x", target: null, calls: [], line: 3, ...extra });

const sender = (filePath: string, ds: DataSourceInfo[]) => ({
  filePath,
  language: "java",
  functions: [{ name: "run", line: 1, endLine: 20, params: [], calls: [] }],
  classes: [],
  dataSources: ds,
}) as unknown as FileAnalysis;

const empty = { nodes: [], edges: [] } as never;

describe("queue nodes: broker and unresolved destinations", () => {
  it("keeps the same name on two brokers apart and meets a publish and a consume on one", () => {
    const files = [
      sender("src/KafkaOut.java", [row({ name: "MQ: Kafka send", target: "matches" })]),
      sender("src/KafkaIn.java", [row({ kind: "queue-consume", name: "MQ: Kafka subscribe", target: "matches" })]),
      sender("src/RabbitIn.java", [row({ kind: "queue-consume", name: "RabbitMQ: consume", target: "matches" })]),
    ];
    const g = buildDataAccessGraph(files);
    expect(g.nodes.filter((n) => n.kind === "queue").map((n) => n.id).sort()).toEqual(["queue::amqp::matches", "queue::kafka::matches"]);
    const links = synthesizeQueueSymbolLinks(attributeDataAccessToSymbols(files, empty));
    expect(links.map((l) => `${l.sourceFile} -> ${l.targetFile}`)).toEqual(["src/KafkaOut.java -> src/KafkaIn.java"]);
  });

  it("gives a row naming no broker the one broker its destination is on", () => {
    const files = [
      sender("src/Out.java", [row({ name: "MQ: send", target: "matches" })]),
      sender("src/In.java", [row({ kind: "queue-consume", name: "Kafka: subscribe", target: "matches" })]),
    ];
    expect(buildDataAccessGraph(files).nodes.filter((n) => n.kind === "queue").map((n) => n.id)).toEqual(["queue::kafka::matches"]);
  });

  it("keys each unresolved destination by where it is written and never pairs them", () => {
    const files = [
      sender("src/A.java", [row({ name: "MQ: send", entity: "x", unresolvedReason: "ambiguous send overload", broker: "amqp", line: 5 })]),
      sender("src/B.java", [row({ kind: "queue-consume", name: "MQ: basicConsume", entity: "x", broker: "amqp", line: 6 })]),
    ];
    const queues = buildDataAccessGraph(files).nodes.filter((n) => n.kind === "queue");
    expect(queues.map((n) => n.id).sort()).toEqual(["queue::amqp::?src/A.java:5", "queue::amqp::?src/B.java:6"]);
    expect(queues.find((n) => n.id.endsWith("A.java:5"))!.reason).toBe("ambiguous send overload");
    expect(synthesizeQueueSymbolLinks(attributeDataAccessToSymbols(files, empty))).toEqual([]);
  });
});
