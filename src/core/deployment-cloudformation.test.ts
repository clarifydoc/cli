import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { collectCloudFormation } from "./deployment-cloudformation.js";
import { detectDeployment } from "./deployment.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-cfn-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const SAM = `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    Runtime: nodejs20.x
Resources:
  LeagueFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: src/league/
      Handler: index.handler
      Environment:
        Variables:
          CLUBS_TABLE: !Ref ClubsTable
          MATCH_QUEUE_URL: !Ref MatchQueue
          STAGE_NAME: !Sub "\${AWS::StackName}-x"
      Events:
        Matches:
          Type: SQS
          Properties:
            Queue: !GetAtt MatchQueue.Arn
        Api:
          Type: Api
          Properties: {Path: /clubs, Method: get}
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref ClubsTable
        - SNSPublishMessagePolicy:
            TopicName: !GetAtt ScoreTopic.TopicName
  ClubsTable:
    Type: AWS::DynamoDB::Table
    Properties: {TableName: !Join ["-", [clubs, !Ref "AWS::Region"]]}
  MatchQueue:
    Type: AWS::SQS::Queue
    Properties: {QueueName: match-queue}
  ScoreTopic:
    Type: AWS::SNS::Topic
  GarageDb:
    Type: AWS::RDS::DBInstance
    Properties: {Engine: postgres}
  Role:
    Type: AWS::IAM::Role
`;

const JSON_TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    CarFunction: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Handler: "app.run",
        Code: "src/cars",
        Environment: { Variables: { GARAGE_TABLE: { Ref: "GarageTable" }, JOBS: { "Fn::GetAtt": ["JobsQueue", "Arn"] }, DB: { "Fn::Sub": "${GarageDb}" } } },
      },
    },
    GarageTable: { Type: "AWS::DynamoDB::Table" },
    JobsQueue: { Type: "AWS::SQS::Queue" },
    GarageDb: { Type: "AWS::RDS::DBInstance", Properties: { Engine: "mysql" } },
  },
});

const view = async (files: Record<string, string>) => {
  const dir = await project(files);
  try {
    const cf = await collectCloudFormation(dir, []);
    return {
      services: (cf?.groups.flat() ?? []).map((s) => `${s.name} ${s.kind ?? "app"}${s.family ? `/${s.family}` : ""}${s.entryFile ? ` ${s.entryFile}` : ""}${s.build ? ` ctx=${s.build.context}` : ""}`).sort(),
      edges: (cf?.edges ?? []).map((e) => `${e.from} → ${e.to} [${e.kind}] ${e.via}`).sort(),
      env: cf?.groups.flat().find((s) => s.name === "leaguefunction" || s.name === "carfunction")?.env,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("CloudFormation deployment", () => {
  it("reads a SAM template (short intrinsics): functions, tables, queues, topics, databases and the edges it states", async () => {
    const v = await view({ "template.yaml": SAM, "src/league/index.js": "exports.handler = async () => {};" });
    expect(v.services).toEqual([
      "clubstable datastore/dynamodb",
      "garagedb datastore/postgres",
      "leaguefunction app src/league/index.js ctx=src/league",
      "match-queue queue/sqs",
      "scoretopic queue/sns",
    ]);
    expect(v.edges).toEqual([
      "leaguefunction → clubstable [db] CLUBS_TABLE",
      "leaguefunction → clubstable [db] policy",
      "leaguefunction → match-queue [bus] MATCH_QUEUE_URL",
      "leaguefunction → match-queue [bus] event source",
      "leaguefunction → scoretopic [bus] policy",
    ]);
    expect(v.env?.CLUBS_TABLE).toBe("!Ref ClubsTable");
  });

  it("reads a JSON template (long intrinsics) and a function's string Code", async () => {
    const v = await view({ "infra/stack.json": JSON_TEMPLATE, "infra/src/cars/app.py": "def run(e, c): pass" });
    expect(v.services).toEqual(["carfunction app infra/src/cars/app.py ctx=infra/src/cars", "garagedb datastore/mysql", "garagetable datastore/dynamodb", "jobsqueue queue/sqs"]);
    expect(v.edges).toEqual(["carfunction → garagedb [db] DB", "carfunction → garagetable [db] GARAGE_TABLE", "carfunction → jobsqueue [bus] JOBS"]);
  });

  it("joins a stack's resources through event source mappings and subscriptions", async () => {
    const v = await view({
      "stack.yml": `Resources:
  Fn:
    Type: AWS::Lambda::Function
    Properties: {Handler: x.y}
  Q:
    Type: AWS::SQS::Queue
  T:
    Type: AWS::SNS::Topic
  Map:
    Type: AWS::Lambda::EventSourceMapping
    Properties:
      FunctionName: !Ref Fn
      EventSourceArn: !GetAtt Q.Arn
  Sub:
    Type: AWS::SNS::Subscription
    Properties: {Protocol: lambda, Endpoint: !GetAtt Fn.Arn, TopicArn: !Ref T}
`,
    });
    expect(v.edges).toEqual(["fn → q [bus] event source", "fn → t [bus] event source"]);
  });

  it("ignores files that are not templates", async () => {
    const v = await view({ "openapi.yaml": "openapi: 3.0.0\npaths: {}\n", "package.json": '{"name":"league"}', "k.yml": "Resources:\n  A:\n    Type: Custom::Thing\n" });
    expect(v.services).toEqual([]);
  });

  it("keeps two stacks' functions of one logical id apart, and meets a resource both name physically", async () => {
    const stack = (handler: string) =>
      `Transform: AWS::Serverless-2016-10-31\nResources:\n  ClubsFunction:\n    Type: AWS::Serverless::Function\n    Properties:\n      CodeUri: src/\n      Handler: ${handler}\n  Matches:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: league-matches\n`;
    const dir = await project({
      "league/template.yaml": stack("clubs.handler"),
      "garage/template.yaml": stack("cars.handler"),
      "league/src/clubs.js": "",
      "garage/src/cars.js": "",
    });
    try {
      const d = await detectDeployment(dir, { subProjects: [] });
      const fns = (d?.services ?? []).filter((s) => s.name.startsWith("clubsfunction"));
      expect(fns.map((s) => s.entryFile).sort()).toEqual(["garage/src/cars.js", "league/src/clubs.js"]);
      expect((d?.services ?? []).filter((s) => s.name === "league-matches")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("puts the template's resources in the deployment inventory", async () => {
    const dir = await project({ "template.yaml": SAM, "src/league/index.js": "" });
    try {
      const d = await detectDeployment(dir, { subProjects: [] });
      expect(d?.services.map((s) => s.name).sort()).toContain("match-queue");
      expect(d?.edges.map((e) => `${e.from} → ${e.to} [${e.kind}]`)).toContain("leaguefunction → clubstable [db]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
