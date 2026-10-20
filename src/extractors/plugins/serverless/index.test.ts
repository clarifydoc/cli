import { describe, expect, it } from "vitest";
import { extractServerlessRoutes } from "./index.js";
import { serverlessMeta } from "./meta.js";

const rows = (yaml: string) =>
  extractServerlessRoutes(yaml.split("\n")).map((r) => `${r.httpMethod ?? "ANY"} ${r.path} ${r.handler ?? "-"} ${r.owner}${r.auth ? ` auth=${r.auth.schemes.join(",")}` : ""}`);

describe("serverless.yml", () => {
  it("reads http and httpApi events, long and short forms, and leaves other events alone", () => {
    expect(rows(`service: s
functions:
  list:
    handler: src/users.list
    events:
      - http:
          path: users
          method: get
      - http: POST users
      - httpApi: 'DELETE /users/{id}'
      - http: { path: users/{id}, method: any, authorizer: { name: auth } }
      - schedule: rate(1 day)
      - sqs: arn:aws:sqs:eu-west-1:1:q
  ping:
    handler: ping.handler
    events:
      - http:
          path: /ping
          method: GET
          private: true
`)).toEqual([
      "GET /users src/users.list list",
      "POST /users src/users.list list",
      "DELETE /users/{id} src/users.list list",
      "ANY /users/{id} src/users.list list auth=auth",
      "GET /ping ping.handler ping auth=api-key",
    ]);
  });
});

describe("SAM template", () => {
  it("joins CodeUri to the handler, keeps a class handler as written, and reads event auth", () => {
    expect(rows(`Transform: AWS::Serverless-2016-10-31
Globals:
  Function:
    CodeUri: src/
Resources:
  Py:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.handler
      Events:
        Get:
          Type: Api
          Properties:
            Path: /items
            Method: get
        Post:
          Type: HttpApi
          Properties:
            Path: /items
            Method: post
            Auth:
              Authorizer: Cognito
        Q:
          Type: SQS
          Properties:
            Queue: arn
  Jvm:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: Fn
      Handler: helloworld.App::handleRequest
      Events:
        Greet:
          Type: Api
          Properties: { Path: /greet, Method: get }
  Bucket:
    Type: AWS::S3::Bucket
`)).toEqual([
      "GET /items src/app.handler Py",
      "POST /items src/app.handler Py auth=Cognito",
      "GET /greet helloworld.App::handleRequest Jvm",
    ]);
  });

  it("claims a template.yaml only when it declares serverless resources", () => {
    expect(serverlessMeta.preprocess!("AWSTemplateFormatVersion: x\nResources:\n  B:\n    Type: AWS::S3::Bucket\n", "infra/template.yaml")).toMatchObject({ skip: expect.any(String) });
    expect(serverlessMeta.preprocess!("Transform: AWS::Serverless-2016-10-31\n", "template.yaml")).toBeNull();
    expect(serverlessMeta.preprocess!("service: x\nprovider:\n  name: aws\n", "serverless.yml")).toMatchObject({ skip: expect.any(String) });
  });
});

describe("non-HTTP events as entry points", () => {
  it("serverless.yml: schedules are scheduled jobs; SQS, SNS and streams are consumers", async () => {
    const { extractServerlessEntryPoints } = await import("./index.js");
    const got = extractServerlessEntryPoints(`service: s
functions:
  nightly:
    handler: src/jobs.nightly
    events:
      - schedule: rate(1 day)
      - eventBridge:
          schedule: cron(0 3 * * ? *)
  worker:
    handler: src/worker.handle
    events:
      - sqs: arn:aws:sqs:eu-west-1:1:orders
      - sns: order-events
      - sqs:
          arn:
            Fn::GetAtt: [PaymentsQueue, Arn]
      - http: GET /x
`.split("\n")).map((e) => `${e.kind} ${e.name} → ${e.handler} [${e.schedule ?? ""}]`);
    expect(got).toEqual([
      "scheduled-job nightly → src/jobs.nightly [rate(1 day)]",
      "scheduled-job nightly → src/jobs.nightly [cron(0 3 * * ? *)]",
      "message-consumer orders → src/worker.handle []",
      "message-consumer order-events → src/worker.handle []",
      "message-consumer PaymentsQueue → src/worker.handle []",
    ]);
  });

  it("SAM: Schedule, SQS and SNS events on a function, with CodeUri joined to the handler", async () => {
    const { extractServerlessEntryPoints } = await import("./index.js");
    const got = extractServerlessEntryPoints(`Transform: AWS::Serverless-2016-10-31
Resources:
  ProcessFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: process/
      Handler: app.handler
      Events:
        Nightly:
          Type: Schedule
          Properties:
            Schedule: rate(1 day)
        FromQueue:
          Type: SQS
          Properties:
            Queue: !GetAtt OrdersQueue.Arn
        FromTopic:
          Type: SNS
          Properties:
            Topic: !Ref OrderTopic
`.split("\n")).map((e) => `${e.kind} ${e.name} → ${e.handler} [${e.schedule ?? ""}]`);
    expect(got).toEqual([
      "scheduled-job ProcessFunction → process/app.handler [rate(1 day)]",
      "message-consumer OrdersQueue → process/app.handler []",
      "message-consumer OrderTopic → process/app.handler []",
    ]);
  });
});
