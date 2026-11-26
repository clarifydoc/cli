import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A table the deployment declares is a data-model node, so the route whose handler writes it reaches a table
 * the model holds. The resource sits in a `${file(…)}` include and names itself with the including descriptor's
 * `${self:custom.tableName}`; a second table no handler writes and a cache `put` stay unmatched.
 */
const files: Record<string, string> = {
  "league/serverless.yml": `service: league
custom:
  stage: \${opt:stage, self:provider.stage}
  tableName: \${self:custom.stage}-clubs
provider:
  name: aws
  stage: dev
  environment:
    tableName: \${self:custom.tableName}
functions:
  addClub:
    handler: add.main
    events:
      - http: { path: clubs, method: post }
  warmCache:
    handler: warm.main
    events:
      - http: { path: warm, method: post }
resources:
  - \${file(resources/clubs-table.yml)}
  - Resources:
      PlayersTable:
        Type: AWS::DynamoDB::Table
        Properties:
          TableName: players-archive
          KeySchema:
            - AttributeName: playerId
              KeyType: HASH
`,
  "league/resources/clubs-table.yml": `Resources:
  ClubsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: \${self:custom.tableName}
      AttributeDefinitions:
        - AttributeName: leagueId
          AttributeType: S
        - AttributeName: clubId
          AttributeType: N
      KeySchema:
        - AttributeName: leagueId
          KeyType: HASH
        - AttributeName: clubId
          KeyType: RANGE
      BillingMode: PAY_PER_REQUEST
`,
  "league/libs/dynamodb-lib.js": `import AWS from "aws-sdk";
const client = new AWS.DynamoDB.DocumentClient();
export default { put: (params) => client.put(params).promise() };
`,
  "league/add.js": `import db from "./libs/dynamodb-lib";
export const main = async (event) => {
  await db.put({ TableName: process.env.tableName, Item: JSON.parse(event.body) });
  return { statusCode: 201 };
};
`,
  "league/warm.js": `import { Map } from "immutable";
const cache = new Map();
export const main = async () => {
  cache.put({ TableName: process.env.tableName, Item: 1 });
  return { statusCode: 200 };
};
`,
};

describe("a deployed table is a data-model node", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-deployed-table-"));
    const root = join(dir, "app");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    summary = await loadReportSummary(out);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the included table with the including descriptor's variables, key schema as columns", () => {
    const node = summary.entityGraph?.nodes.find((n) => n.name === "dev-clubs");
    expect(node).toMatchObject({ origin: "deployed", orm: "dynamodb", filePath: "league/resources/clubs-table.yml" });
    expect(node?.columns).toEqual([
      { name: "leagueId", type: "S", isPrimaryKey: true },
      { name: "clubId", type: "N", isPrimaryKey: true },
    ]);
  });

  it("names it the same on an incremental run, which does not re-read a descriptor it once turned down", async () => {
    const out = join(dir, "out");
    await writeFile(join(dir, "app/league/add.js"), `${files["league/add.js"]}// edited\n`);
    await analyze({ projectRoot: join(dir, "app"), outputDir: out, lsp: false, gitHistory: false, stableOutput: true, incremental: true });
    const again = await loadReportSummary(out);
    expect(again.entityGraph?.nodes.map((n) => n.name).sort()).toEqual(summary.entityGraph?.nodes.map((n) => n.name).sort());
  });

  it("holds an inline table too, though no handler writes it", () => {
    expect(summary.entityGraph?.nodes.find((n) => n.name === "players-archive")).toMatchObject({ origin: "deployed" });
    expect((summary.symbolDataAccess ?? []).some((r) => r.entity === "players-archive")).toBe(false);
  });

  it("matches the handler's write to the node, and a cache put to nothing", () => {
    const rows = (summary.symbolDataAccess ?? []).filter((r) => r.file === "league/add.js");
    expect(rows.map((r) => [r.entity, r.entityMatched])).toEqual([["dev-clubs", true]]);
    expect((summary.symbolDataAccess ?? []).filter((r) => r.file === "league/warm.js")).toEqual([]);
  });
});

describe("a descriptor that only includes its resources, on an incremental run", () => {
  let dir: string;
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is read again, so the included table keeps its name when only the include changed", async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-deployed-include-"));
    const root = join(dir, "app");
    const include = `Resources:
  GarageTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: \${self:custom.tableName}
      KeySchema:
        - AttributeName: carId
          KeyType: HASH
`;
    const project: Record<string, string> = {
      // No resource of its own: the cache would turn it down as nothing and never read it again.
      "garage/serverless.yml": `service: garage
custom:
  tableName: dev-garage
provider:
  name: aws
functions:
  addCar:
    handler: add.main
    events:
      - http: { path: cars, method: post }
resources:
  - \${file(resources/garage-table.yml)}
`,
      "garage/resources/garage-table.yml": include,
      "garage/add.js": `export const main = async () => ({ statusCode: 201 });\n`,
    };
    for (const [path, text] of Object.entries(project)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const out = join(dir, "out");
    const run = async (incremental: boolean): Promise<string[]> => {
      await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true, incremental });
      return ((await loadReportSummary(out)).entityGraph?.nodes ?? []).map((n) => n.name);
    };
    expect(await run(false)).toEqual(["dev-garage"]);
    await writeFile(join(root, "garage/resources/garage-table.yml"), `${include}      BillingMode: PAY_PER_REQUEST\n`);
    expect(await run(true)).toEqual(["dev-garage"]);
  });
});
