import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** One project of invented files; the MQTT rows the analysis ends with, by function: `symbol kind topic`. */
async function mqttRows(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-mqtt-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: dir, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const s = await loadReportSummary(out);
    return (s.symbolDataAccess ?? []).filter((d) => d.access?.startsWith("queue")).map((d) => `${d.symbol} ${d.access} ${d.datastore ?? "?"}`).sort();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("MQTT topics named by a constant another module declares", () => {
  it("JavaScript: an imported constant and a namespace member, the subscriber's literal meets them", async () => {
    expect(
      await mqttRows({
        "src/topics.ts": `export const SCORES = 'league/scores';\nexport const Topics = { cards: 'league/+/cards' };\n`,
        "src/pub.ts": `import mqtt from 'mqtt';\nimport { SCORES, Topics } from './topics';\nconst client = mqtt.connect('mqtt://b');\nexport function sendScore() { client.publish(SCORES, '1-0'); }\nexport function sendCard() { client.publish(Topics.cards, 'x'); }\nexport function sendLocal(topic: string) { client.publish(topic, 'x'); }\n`,
        "src/sub.ts": `import mqtt from 'mqtt';\nconst client = mqtt.connect('mqtt://b');\nexport function listen() { client.subscribe(['league/scores', 'league/+/cards']); }\n`,
      }),
    ).toEqual(["listen queue-consume league/+/cards", "listen queue-consume league/scores", "sendCard queue-publish league/+/cards", "sendScore queue-publish league/scores"].sort());
  });

  it("Python: a name imported from a module, the list form, and a variable that is no constant", async () => {
    expect(
      await mqttRows({
        "app/topics.py": `SCORES = "league/scores"\nCARDS = "league/+/cards"\n`,
        "app/pub.py": `import paho.mqtt.client as mqtt\nfrom app.topics import SCORES, CARDS\nc = mqtt.Client()\ndef send_score():\n    c.publish(SCORES, "1-0")\ndef send_card():\n    c.publish(CARDS, "x")\ndef send_any(topic):\n    c.publish(topic, "x")\n`,
        "app/sub.py": `import paho.mqtt.client as mqtt\nc = mqtt.Client()\ndef listen():\n    c.subscribe([("league/scores", 0), ("league/+/cards", 1)])\n`,
      }),
    ).toEqual(["listen queue-consume league/+/cards", "listen queue-consume league/scores", "send_card queue-publish league/+/cards", "send_score queue-publish league/scores"]);
  });

  it("Go: an exported constant of another package, SubscribeMultiple's map keys, a lowercase variable that is no constant", async () => {
    expect(
      await mqttRows({
        "go.mod": "module example.com/league\n\ngo 1.22\n",
        "topics/topics.go": `package topics\n\nconst Scores = "league/scores"\n`,
        "pub/pub.go": `package pub\n\nimport (\n\tmqtt "github.com/eclipse/paho.mqtt.golang"\n\t"example.com/league/topics"\n)\n\nfunc SendScore(c mqtt.Client) {\n\tc.Publish(topics.Scores, 0, false, "1-0")\n}\n\nfunc SendAny(c mqtt.Client, topic string) {\n\tc.Publish(topic, 0, false, "x")\n}\n`,
        "sub/sub.go": `package sub\n\nimport mqtt "github.com/eclipse/paho.mqtt.golang"\n\nfunc Listen(c mqtt.Client) {\n\tc.SubscribeMultiple(map[string]byte{"league/scores": 0, "league/+/cards": 1}, nil)\n}\n`,
      }),
    ).toEqual(["Listen queue-consume league/+/cards", "Listen queue-consume league/scores", "SendScore queue-publish league/scores"]);
  });

  it("Java: a constant of another class, and an unknown namesake that names nothing", async () => {
    expect(
      await mqttRows({
        "src/main/java/com/example/league/Topics.java": `package com.example.league;\npublic class Topics { public static final String SCORES = "league/scores"; }\n`,
        "src/main/java/com/example/league/Pub.java": `package com.example.league;\nimport org.eclipse.paho.client.mqttv3.*;\npublic class Pub {\n  void sendScore(MqttClient client) throws Exception { client.publish(Topics.SCORES, new MqttMessage()); }\n  void sendAny(MqttClient client, String topic) throws Exception { client.publish(topic, new MqttMessage()); }\n}\n`,
        "src/main/java/com/example/league/Sub.java": `package com.example.league;\nimport org.eclipse.paho.client.mqttv3.*;\npublic class Sub {\n  void listen(MqttClient client) throws Exception { client.subscribe("league/scores"); }\n}\n`,
      }),
    ).toEqual(["Pub.sendScore queue-publish league/scores", "Sub.listen queue-consume league/scores"]);
  });

  it("C#: a constant of another class", async () => {
    expect(
      await mqttRows({
        "Topics.cs": `namespace League;\npublic static class Topics { public const string Scores = "league/scores"; }\n`,
        "Pub.cs": `using MQTTnet;\nnamespace League;\npublic class Pub { public void SendScore() { var m = new MqttApplicationMessageBuilder().WithTopic(Topics.Scores).Build(); }\n  public void SendAny(string topic) { var m = new MqttApplicationMessageBuilder().WithTopic(topic).Build(); } }\n`,
        "Sub.cs": `using MQTTnet;\nnamespace League;\npublic class Sub { public void Listen() { var f = new MqttTopicFilterBuilder().WithTopic("league/scores").Build(); } }\n`,
      }),
    ).toEqual(["Pub.SendScore queue-publish league/scores", "Sub.Listen queue-consume league/scores"]);
  });
});
