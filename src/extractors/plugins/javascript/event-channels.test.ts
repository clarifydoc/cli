import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { PythonDataSourceExtractor } from "../python/data-sources.js";

const channels = async (src: string, language: "typescript" | "python" = "typescript") => {
  const tree = await parseSource(src, language as never, language === "python" ? "x.py" : "x.ts");
  const ex = language === "python" ? new PythonDataSourceExtractor() : new JavaScriptDataSourceExtractor();
  return ex.extract(tree, src).filter((d) => d.kind === "queue-publish" || d.kind === "queue-consume").map((d) => `${d.kind === "queue-publish" ? "pub" : "sub"} ${d.target} (${d.name}) @${d.line}`);
};

describe("in-process events and cloud queues as channels", () => {
  it("NestJS events: emit publishes, @OnEvent consumes on its method", async () => {
    expect(await channels(`import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
export class Cars {
  constructor(private eventEmitter: EventEmitter2) {}
  place() { this.eventEmitter.emit("car.created", { id: 1 }); }
}
export class Mailer {
  @OnEvent("car.created")
  send(e: unknown) {}
}`)).toEqual(["pub car.created (NestJS: emit) @4", "sub car.created (NestJS: OnEvent) @8"]);
  });

  it("Node EventEmitter and mitt: emit and on, never the process, a request or a stream", async () => {
    expect(await channels(`import { EventEmitter } from "events";
export const bus = new EventEmitter();
bus.emit("car.created", o);
bus.on("car.created", sendMail);
process.on("exit", cleanup);
req.on("data", chunk);
stream.on("end", done);
emitter.on("car.paid", ship);
export class Jobs extends EventEmitter { run() { this.emit("job.done", 1); } }
widget.on("click", handler);`)).toEqual([
      "pub car.created (EventEmitter: emit) @3",
      "sub car.created (EventEmitter: on) @4",
      "sub car.paid (EventEmitter: on) @8",
      "pub job.done (EventEmitter: emit) @9",
    ]);
  });

  it("SQS and SNS through the AWS SDK and sqs-consumer; Redis pub/sub", async () => {
    expect(await channels(`import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { PublishCommand } from "@aws-sdk/client-sns";
import { createClient } from "redis";
await sqs.send(new SendMessageCommand({ QueueUrl: process.env.CARS_QUEUE_URL, MessageBody: "x" }));
await sqs.send(new ReceiveMessageCommand({ QueueUrl: "https://sqs.eu-west-1.amazonaws.com/123/cars" }));
await sns.send(new PublishCommand({ TopicArn: "arn:aws:sns:eu-west-1:123:car-events", Message: "x" }));
Consumer.create({ queueUrl: QUEUE_URL, handleMessage });
await pub.publish("notifications", JSON.stringify(n));
await sub.subscribe("notifications", onNote);`)).toEqual([
      "pub CARS_QUEUE_URL (SQS: send) @4",
      "sub cars (SQS: receive) @5",
      "pub car-events (SNS: publish) @6",
      "sub QUEUE_URL (SQS: consumer) @7",
      "pub notifications (Redis: publish) @8",
      "sub notifications (Redis: subscribe) @9",
    ]);
  });

  it("Python: boto3 SQS/SNS and redis-py pub/sub", async () => {
    expect(await channels(`import boto3
import redis
sqs = boto3.client("sqs")
sqs.send_message(QueueUrl=os.environ["CARS_QUEUE_URL"], MessageBody="x")
sqs.receive_message(QueueUrl="https://sqs.eu-west-1.amazonaws.com/123/cars")
sns.publish(TopicArn="arn:aws:sns:eu-west-1:123:car-events", Message="x")
r.publish("notifications", "hi")
p.subscribe("notifications")
`, "python")).toEqual([
      "pub CARS_QUEUE_URL (SQS: send) @4",
      "sub cars (SQS: receive) @5",
      "pub car-events (SNS: publish) @6",
      "pub notifications (Redis: publish) @7",
      "sub notifications (Redis: subscribe) @8",
    ]);
  });
});
