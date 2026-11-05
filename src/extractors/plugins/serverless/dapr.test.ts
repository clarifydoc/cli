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

describe("a Dapr subscription on a route composed by an Express mount", () => {
  it("lands on the mounted router's route, not on the descriptor", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join, dirname } = await import("path");
    const { analyze } = await import("../../../core/analyzer.js");
    const { loadReportSummary } = await import("../../../core/report-payload.js");
    const dir = await mkdtemp(join(tmpdir(), "cd-dapr-mount-"));
    const files: Record<string, string> = {
      "package.json": `{"name":"club","dependencies":{"express":"4"}}`,
      "components/sub.yaml": `apiVersion: dapr.io/v1alpha1\nkind: Subscription\nmetadata:\n  name: score\nspec:\n  pubsubname: pubsub\n  topic: goal-scored\n  route: /events/score\n`,
      "events.js": `const express = require('express');\nconst router = express.Router();\nrouter.post('/score', (req, res) => { res.sendStatus(200); });\nrouter.post('/decoy', (req, res) => { res.sendStatus(200); });\nmodule.exports = router;\n`,
      "app.js": `const express = require('express');\nconst events = require('./events');\nconst app = express();\napp.use('/events', events);\n`,
    };
    try {
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
        await writeFile(join(dir, "app", rel), text);
      }
      await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
      const summary = await loadReportSummary(join(dir, "out"));
      const rows = (summary.symbolDataAccess ?? []).filter((r) => r.access === "queue-consume" || r.entity === "goal-scored");
      expect(rows.map((r) => `${r.file} ${r.symbol} ${r.entity}`)).toEqual(["events.js route:POST /events/score goal-scored"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
