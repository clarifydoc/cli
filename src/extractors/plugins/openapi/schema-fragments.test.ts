import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { isSchemaFragment } from "./meta.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A spec that keeps each model in a file of its own, named by `$ref: './x.yaml'`
 * (real-repo FP: 6 entities instead of ~67, and no request body had a schema).
 */
const FILES: Record<string, string> = {
  "openapi/league-api.yaml": `openapi: 3.0.3
info: { title: League, version: '1' }
paths:
  /clubs:
    post:
      operationId: createClub
      requestBody:
        content:
          application/json:
            schema:
              $ref: './club/CreateClub.yaml'
      responses:
        '201':
          description: created
components:
  schemas:
    League:
      type: object
      properties:
        clubs:
          type: array
          items:
            $ref: './club/Club.yaml'
`,
  "openapi/club/ClubBase.yaml": `type: object
properties:
  name:
    type: string
  founded:
    type: integer
`,
  "openapi/club/Club.yaml": `description: a club
type: object
allOf:
  - $ref: './ClubBase.yaml'
  - properties:
      stadium:
        $ref: '../Stadium.yaml'
`,
  "openapi/club/CreateClub.yaml": `type: object
required: [name]
allOf:
  - $ref: './ClubBase.yaml'
`,
  "openapi/Stadium.yaml": `type: object
properties:
  capacity:
    type: integer
`,
  "openapi/Division.yaml": `type: string
enum: [PREMIER, CHAMPIONSHIP]
`,
};

describe("OpenAPI schema fragments", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-openapi-fragments-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads each schema file as the entity its file names, with its relations", () => {
    const nodes = (summary.entityGraph?.nodes ?? []).map((n) => `${n.name} ${n.columns.map((c) => c.name).join(",")}`).sort();
    expect(nodes).toEqual(["Club stadium", "ClubBase name,founded", "CreateClub ", "Division ", "League clubs", "Stadium capacity"]);
    const edges = (summary.entityGraph?.edges ?? []).map((e) => [e.source.split("::").pop(), e.target.split("::").pop()].sort().join(" - ")).sort();
    expect(edges).toEqual(["Club - League", "Club - Stadium"]);
  });

  it("flattens a request body named by file through the fragments it composes", () => {
    const create = (summary.routeMap ?? []).find((r) => r.handler === "createClub") as { requestSchema?: { properties?: object } } | undefined;
    expect(Object.keys(create?.requestSchema?.properties ?? {})).toEqual(["name", "founded"]);
  });

  it("claims only a YAML whose root is a schema", () => {
    expect(isSchemaFragment("type: object\nproperties:\n  a: { type: string }\n", "a/B.yaml")).toBe(true);
    expect(isSchemaFragment("type: string\nenum: [A]\n", "a/B.yml")).toBe(true);
    expect(isSchemaFragment("services:\n  web:\n    type: object\n    properties: {}\n", "docker-compose.yaml")).toBe(false);
    expect(isSchemaFragment("type: object\nproperties: {}\n", "schema.json")).toBe(false);
    expect(isSchemaFragment("name: ci\ntype: object\n", "x.yaml")).toBe(false);
  });
});
