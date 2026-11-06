import { describe, it, expect } from "vitest";
import { extractGoDataSources } from "./data-sources.js";

const rows = (src: string) => extractGoDataSources(src.split("\n")).filter((d) => d.kind.startsWith("queue")).map((d) => `${d.kind} ${d.name} ${d.target}`);

describe("AWS SDK v2 SQS and SNS", () => {
  const imports = `import ("github.com/aws/aws-sdk-go-v2/service/sqs"; "github.com/aws/aws-sdk-go-v2/service/sns")`;
  it("reads the queue and topic the input struct names", () => {
    expect(rows(`${imports}
const fixtureQueue = "https://sqs.example/fixtures"
func a() {
	client.SendMessage(ctx, &sqs.SendMessageInput{ QueueUrl: aws.String(fixtureQueue), MessageBody: aws.String("x") })
	out, _ := client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl: aws.String("https://sqs.example/fixtures"),
	})
	c.Publish(ctx, &sns.PublishInput{ TopicArn: aws.String("arn:goals"), Message: aws.String("g") })
}`)).toEqual([
      "queue-publish AWS: SendMessage https://sqs.example/fixtures",
      "queue-consume AWS: ReceiveMessage https://sqs.example/fixtures",
      "queue-publish AWS: Publish arn:goals",
    ]);
  });
  it("reads an input built into a local, and ignores a file without the SDK", () => {
    expect(rows(`${imports}
func a() {
	in := &sqs.SendMessageInput{ QueueUrl: aws.String("q1") }
	client.SendMessage(ctx, in)
}`)).toEqual(["queue-publish AWS: SendMessage q1"]);
    expect(rows(`func a() { client.SendMessage(ctx, &sqs.SendMessageInput{ QueueUrl: aws.String("q1") }) }`)).toEqual([]);
  });
});

describe("Go MQTT clients (paho)", () => {
  it("marks Publish and Subscribe topics as MQTT, only in a file that imports paho", () => {
    const mqtt = extractGoDataSources(`import mqtt "github.com/eclipse/paho.mqtt.golang"
func a() {
	client.Subscribe("stadium/+/score", 0, onScore)
	client.Publish("stadium/home/score", 0, false, "2")
}`.split("\n")).filter((d) => d.kind.startsWith("queue")).map((d) => [d.kind, d.target, d.topicSyntax]);
    expect(mqtt).toEqual([["queue-consume", "stadium/+/score", "mqtt"], ["queue-publish", "stadium/home/score", "mqtt"]]);
    expect(rows(`func a() { client.Publish("stadium/home/score", 0, false, "2") }`)).toEqual([]);
  });
});
