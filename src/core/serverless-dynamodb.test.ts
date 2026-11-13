import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A DynamoDB client names its table by an environment variable (`TableName: process.env.CLUBS_TABLE`);
 * the descriptor of the service that runs the code sets it. The route then reaches that table.
 */
const files: Record<string, string> = {
  "league/serverless.yml": `service: league
provider:
  name: aws
  environment:
    CLUBS_TABLE: \${self:service}-clubs
    MATCHES_TABLE: !Ref MatchesTable
    STAGED_TABLE: \${opt:stage}-staged
functions:
  listClubs:
    handler: src/clubs.list
    events:
      - http: { path: clubs, method: get }
  addPlayer:
    handler: src/players.add
    environment:
      PLAYERS_TABLE: players-prod
    events:
      - http: { path: players, method: post }
  listMatches:
    handler: src/matches.list
    events:
      - httpApi: 'GET /matches'
  listStaged:
    handler: src/staged.list
    events:
      - httpApi: 'GET /staged'
resources:
  Resources:
    MatchesTable:
      Type: AWS::DynamoDB::Table
      Properties:
        TableName: match-reports
`,
  "league/src/clubs.js": `const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
const TABLE = process.env.CLUBS_TABLE;
exports.list = async () => {
  const out = await docClient.scan({ TableName: TABLE }).promise();
  return { statusCode: 200, body: JSON.stringify(out.Items) };
};
`,
  "league/src/players.js": `import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
const ddb = DynamoDBDocumentClient.from({});
export const add = async (event) => {
  await ddb.send(new PutCommand({ TableName: process.env.PLAYERS_TABLE, Item: JSON.parse(event.body) }));
  return { statusCode: 201 };
};
`,
  "league/src/matches.js": `const { DynamoDB } = require("aws-sdk");
const client = new DynamoDB.DocumentClient();
exports.list = async () => {
  const params = { TableName: process.env.MATCHES_TABLE, Limit: 10 };
  return client.query(params).promise();
};
`,
  "league/src/staged.js": `const { DynamoDB } = require("aws-sdk");
const client = new DynamoDB.DocumentClient();
exports.list = async () => client.scan({ TableName: process.env.STAGED_TABLE }).promise();
`,
  // Decoy: CLUBS_TABLE is set by the league service's descriptor, not by this one.
  "stadiums/serverless.yml": `service: stadiums
provider:
  name: aws
functions:
  listStadiums:
    handler: src/stadiums.list
    events:
      - http: { path: stadiums, method: get }
`,
  "stadiums/src/stadiums.js": `const { DynamoDB } = require("aws-sdk");
const client = new DynamoDB.DocumentClient();
exports.list = async () => client.scan({ TableName: process.env.CLUBS_TABLE }).promise();
`,
  "sam/template.yaml": `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Environment:
      Variables:
        GARAGE_TABLE: !Ref GarageTable
Resources:
  GarageTable:
    Type: AWS::Serverless::SimpleTable
  ListCarsFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: cars.list
      Environment:
        Variables:
          CARS_TABLE: cars-v2
      Events:
        List: { Type: Api, Properties: { Path: /cars, Method: get } }
  ListGarageFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/
      Handler: garage.list
      Events:
        List: { Type: Api, Properties: { Path: /garage, Method: get } }
`,
  "sam/src/cars.js": `const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const ddb = DynamoDBDocumentClient.from({});
const { CARS_TABLE } = process.env;
exports.list = async () => ddb.send(new ScanCommand({ TableName: CARS_TABLE }));
`,
  "sam/src/garage.js": `const AWS = require("aws-sdk");
const docClient = new AWS.DynamoDB.DocumentClient();
exports.list = async () => docClient.scan({ TableName: process.env.GARAGE_TABLE }).promise();
`,
};

describe("DynamoDB tables named by an environment variable", () => {
  let dir: string;
  let flows: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-dynamo-"));
    const root = join(dir, "app");
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const s = await loadReportSummary(out);
    flows = (s.dataFlows ?? []).map((p) => `${p.entryLabel} ${p.effect} ${p.resource}`).sort();
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reaches the table a descriptor's environment sets: literal, ${self:}, a Ref to a table, a function's own, SAM Globals", () => {
    expect(flows).toEqual([
      "GET /cars db-read cars-v2",
      "GET /clubs db-read league-clubs",
      "GET /garage db-read GarageTable",
      "GET /matches db-read match-reports",
      "POST /players db-write players-prod",
    ]);
  });

  it("never guesses a table: a deploy-time value, or a variable another service's descriptor sets", () => {
    expect(flows.some((f) => f.includes("/staged") || f.includes("/stadiums"))).toBe(false);
  });
});
