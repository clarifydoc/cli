import { describe, expect, it } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { FileAnalysis, RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import { openapiMeta } from "../openapi/meta.js";
import { daprSubscriptions, extractDaprSubscriptions } from "./dapr.js";

const SUBSCRIPTIONS = `apiVersion: dapr.io/v2alpha1
kind: Subscription
metadata:
  name: club-sub
spec:
  pubsubname: pubsub
  topic: club-created
  routes:
    rules:
      - match: event.type == "club.renamed"
        path: /club-renamed
    default: /club-created
scopes:
  - clubs-api
---
apiVersion: dapr.io/v1alpha1
kind: Subscription
metadata:
  name: player-sub
spec:
  topic: player-signed
  route: player-signed
  pubsubname: pubsub
---
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: pubsub
spec:
  type: pubsub.redis
`;

const factsOf = (yaml: string): RouteFact[] => {
  const facts: RouteFact[] = [];
  extractDaprSubscriptions(yaml.split("\n"), facts);
  return facts;
};

describe("Dapr subscriptions", () => {
  it("reads each Subscription document's topic and the paths it delivers to, never a component", () => {
    expect(factsOf(SUBSCRIPTIONS).map((f) => [f.line, f.data])).toEqual([
      [2, { topic: "club-created", pubsub: "pubsub", paths: ["/club-created", "/club-renamed"] }],
      [17, { topic: "player-signed", pubsub: "pubsub", paths: ["/player-signed"] }],
    ]);
  });

  it("is handed over by the owner of .yaml, which keeps refusing other YAML", () => {
    expect(openapiMeta.preprocess!(SUBSCRIPTIONS, "deploy/subscriptions.yaml")).toEqual({ sourceText: SUBSCRIPTIONS, language: "serverless" });
    expect(openapiMeta.preprocess!("apiVersion: dapr.io/v1alpha1\nkind: Component\n", "deploy/pubsub.yaml")).toHaveProperty("skip");
  });

  it("puts a consume of the topic on the function serving each path, and keeps an unserved one on the descriptor", () => {
    const descriptor = extractWithRegex(SUBSCRIPTIONS, "deploy/subscriptions.yaml", "serverless");
    const controller = {
      filePath: "Clubs.Api/EventsController.cs",
      language: "csharp",
      functions: [],
      classes: [{ name: "EventsController", methods: [{ name: "OnClubCreated", line: 6, endLine: 10 }, { name: "OnClubRenamed", line: 11, endLine: 12 }] }],
      routes: [
        { path: "/club-created", httpMethod: "POST", kind: "api", handler: "OnClubCreated", calls: [], middleware: [], line: 6 },
        { path: "/club-renamed", httpMethod: "GET", kind: "api", handler: "OnClubRenamed", calls: [], middleware: [], line: 11 },
      ],
      dataSources: [],
    } as unknown as FileAnalysis;
    const program = {
      filePath: "Players.Api/Program.cs",
      language: "csharp",
      functions: [{ name: "<setup>", line: 1, endLine: 3 }],
      classes: [],
      routes: [{ path: "/player-signed", httpMethod: "POST", kind: "api", handler: null, calls: [], middleware: [], line: 2 }],
      dataSources: [],
    } as unknown as FileAnalysis;
    daprSubscriptions.resolve([descriptor, controller, program], {} as ProjectContext);
    const brief = (a: FileAnalysis) => a.dataSources.map((d) => `${d.kind} ${d.target} @${d.line} ${d.handler ?? "-"}`);
    expect(brief(controller)).toEqual(["queue-consume club-created @6 EventsController.OnClubCreated"]);
    // An inline handler: the route itself is the consumer.
    expect(brief(program)).toEqual(["queue-consume player-signed @2 route:POST /player-signed"]);
    // `/club-renamed` is served by a GET only — Dapr delivers with POST.
    expect(brief(descriptor)).toEqual(["queue-consume club-created @2 -"]);
  });
});
