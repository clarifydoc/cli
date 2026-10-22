import { describe, it, expect } from "vitest";
import "../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor } from "./csharp/data-sources.js";
import { JavaScriptDataSourceExtractor } from "./javascript/data-sources.js";
import { PythonDataSourceExtractor } from "./python/data-sources.js";
import { JavaKotlinDataSourceExtractor } from "./java-kotlin/data-sources.js";
import { PhpDataSourceExtractor } from "./php/data-sources.js";
import type { DataSourceInfo } from "../../types/analysis.js";

/**
 * Message-queue publish/consume extraction — the "event on RabbitMQ" endpoint
 * of a button→API→handler→broker trace. Shapes are lifted from the corpus:
 * two real repos (C# RabbitMQ.Client v7 + publisher wrappers), plus
 * the standard client libraries per language (amqplib, kafkajs, pika,
 * Spring AMQP/Kafka, php-amqplib).
 */

const publishes = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "queue-publish");
const consumes = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "queue-consume");

// ─── C# ──────────────────────────────────────────────────────────────────────

async function csharpSourcesOf(body: string): Promise<DataSourceInfo[]> {
  const src = `namespace X;
public class H {
  public async Task M(CancellationToken ct) {
${body}
  }
}`;
  const tree = await parseSource(src, "csharp" as any, "H.cs");
  return new CSharpDataSourceExtractor().extract(tree, src);
}

describe("C# RabbitMQ.Client extraction", () => {
  it("captures BasicPublishAsync with named args (real-repo EventPublisher shape)", async () => {
    const s = await csharpSourcesOf(
      `    await channel.BasicPublishAsync(exchange: _exchange, routingKey: routingKey, mandatory: false, basicProperties: props, body: body, cancellationToken: ct);`,
    );
    const [p] = publishes(s);
    expect(p).toBeDefined();
    expect(p!.target).toBe("_exchange");
    expect(p!.entity).toBeUndefined(); // routingKey is a runtime value
  });

  it("captures positional BasicPublish with literal exchange + routing key", async () => {
    const s = await csharpSourcesOf(`    channel.BasicPublish("cars", "car.created", props, body);`);
    const [p] = publishes(s);
    expect(p!.target).toBe("cars");
    expect(p!.entity).toBe("car.created");
  });

  it("captures BasicConsumeAsync queue by named arg (config-driven name kept as label)", async () => {
    const s = await csharpSourcesOf(
      `    await channel.BasicConsumeAsync(queue: _cfg.Queue, autoAck: false, consumer: _consumer, cancellationToken: ct);`,
    );
    const [c] = consumes(s);
    expect(c).toBeDefined();
    expect(c!.target).toBe("_cfg.Queue");
  });

  it("captures a publisher-wrapper call and derives the event from X.RoutingKey (ticket-rights shape)", async () => {
    const s = await csharpSourcesOf(
      `    await producer.ProduceAsync(message, GrantExpiringMessage.RoutingKey, ct);`,
    );
    const [p] = publishes(s);
    expect(p).toBeDefined();
    expect(p!.entity).toBe("GrantExpiringMessage");
  });

  it("derives the event name from a `new XMessage(...)` argument", async () => {
    const s = await csharpSourcesOf(
      `    await _eventPublisher.PublishAsync(new CarCreatedEvent(id), ct);`,
    );
    expect(publishes(s)[0]?.entity).toBe("CarCreatedEvent");
  });

  it("resolves a file-local `const string` exchange to its value", async () => {
    const src = `namespace X;
public class P {
  private const string Exchange = "shop-events";
  public async Task M(IChannel channel, byte[] body, CancellationToken ct) {
    await channel.BasicPublishAsync(exchange: Exchange, routingKey: "car.placed", mandatory: false, body: body, cancellationToken: ct);
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "P.cs");
    const s = new CSharpDataSourceExtractor().extract(tree, src);
    const [p] = publishes(s);
    expect(p!.target).toBe("shop-events");
    expect(p!.entity).toBe("car.placed");
  });

  it("publishes on an event bus by the type of message it builds, through a local or a branch", async () => {
    const s = await csharpSourcesOf(`    var played = new MatchPlayedIntegrationEvent(id);
    await eventBus.PublishAsync(played);
    IntegrationEvent result;
    if (won) { result = new MatchWonIntegrationEvent(id); } else { result = (IntegrationEvent)new MatchLostIntegrationEvent(id); }
    await _eventBus.PublishAsync(result);`);
    expect(publishes(s).map((p) => `${p.target} @${p.line}`)).toEqual([
      "MatchPlayedIntegrationEvent @5",
      "MatchWonIntegrationEvent @8",
      "MatchLostIntegrationEvent @8",
    ]);
  });

  it("publishes an integration event handed to an outbox service, never a parameter it relays", async () => {
    const s = await csharpSourcesOf(`    var transfer = new PlayerTransferredIntegrationEvent(id);
    await _leagueEventService.AddAndSaveEventAsync(transfer);
    await _calendar.AddEventAsync(new TrainingSession(id));`);
    expect(publishes(s).map((p) => p.target)).toEqual(["PlayerTransferredIntegrationEvent"]);
    const relay = await csharpSourcesOf(`    await _eventBus.PublishAsync(evt);`);
    expect(publishes(relay).map((p) => p.target)).toEqual([null]);
  });

  it("consumes the message type a handler class implements, on its Handle method", async () => {
    const src = `namespace X;
public class TransferHandler(LeagueContext db) : IIntegrationEventHandler<PlayerTransferredIntegrationEvent>
{
    public async Task Handle(PlayerTransferredIntegrationEvent @event) { await db.SaveChangesAsync(); }
}
public class KitConsumer : IConsumer<KitOrdered>, IConsumer<string, byte[]>
{
    public Task Consume(ConsumeContext<KitOrdered> context) => Task.CompletedTask;
}`;
    const tree = await parseSource(src, "csharp" as any, "T.cs");
    const s = new CSharpDataSourceExtractor().extract(tree, src);
    expect(consumes(s).map((c) => `${c.target} @${c.line}`)).toEqual(["PlayerTransferredIntegrationEvent @4", "KitOrdered @8"]);
  });

  it("ignores MediatR's in-process _mediator.Publish", async () => {
    const s = await csharpSourcesOf(`    await _mediator.Publish(new Notification(), ct);`);
    expect(publishes(s)).toHaveLength(0);
  });

  it("ignores Publish-like methods on non-broker receivers", async () => {
    const s = await csharpSourcesOf(`    await _gameService.PublishAsync(game, ct);`);
    expect(publishes(s)).toHaveLength(0);
  });
});

// ─── JavaScript / TypeScript ─────────────────────────────────────────────────

async function jsSourcesOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor().extract(tree, src);
}

describe("JS amqplib + kafkajs extraction", () => {
  it("captures channel.sendToQueue on any receiver (name is amqplib-specific)", async () => {
    const s = await jsSourcesOf(`async function go(ch: any) { await ch.sendToQueue('tasks', Buffer.from('x')); }`);
    const [p] = publishes(s);
    expect(p!.target).toBe("tasks");
  });

  it("captures channel.publish exchange + routing key", async () => {
    const s = await jsSourcesOf(`async function go(channel: any) { channel.publish('cars', 'car.created', buf); }`);
    const [p] = publishes(s);
    expect(p!.target).toBe("cars");
    expect(p!.entity).toBe("car.created");
  });

  it("captures channel.consume", async () => {
    const s = await jsSourcesOf(`async function go(channel: any) { await channel.consume('tasks', handle); }`);
    expect(consumes(s)[0]?.target).toBe("tasks");
  });

  it("ignores publish on a non-channel receiver (event-bus pattern)", async () => {
    const s = await jsSourcesOf(`function go(eventBus: any) { eventBus.publish('evt', data); }`);
    expect(publishes(s)).toHaveLength(0);
  });

  it("captures kafkajs producer.send({ topic })", async () => {
    const s = await jsSourcesOf(`async function go(producer: any) { await producer.send({ topic: 'player-events', messages: [] }); }`);
    expect(publishes(s)[0]?.target).toBe("player-events");
  });

  it("captures kafkajs consumer.subscribe({ topics: [...] }) — one source per topic", async () => {
    const s = await jsSourcesOf(`async function go(consumer: any) { await consumer.subscribe({ topics: ['a-events', 'b-events'] }); }`);
    expect(consumes(s).map((c) => c.target)).toEqual(["a-events", "b-events"]);
  });
});

const brief = (s: DataSourceInfo[]) => s.filter((d) => d.kind.startsWith("queue-")).map((d) => `${d.kind} ${d.name} ${d.target}${d.entity ? ` ${d.entity}` : ""} @${d.line}`);

describe("JS BullMQ / Bull extraction", () => {
  it("publishes on a receiver bound to a queue, consumes in a Worker, and names the queue", async () => {
    const s = await jsSourcesOf(`import { Queue, Worker } from "bullmq";
const emailQueue = new Queue("emails", { connection });
export async function signup(player) { await emailQueue.add("welcome", { id: player.id }); }
new Worker("emails", async (job) => send(job.data));
const other = { add: (x) => x };
other.add("welcome");`);
    expect(brief(s)).toEqual(["queue-publish BullMQ: add emails welcome @3", "queue-consume BullMQ: Worker emails @4"]);
  });

  it("reads NestJS @InjectQueue receivers and @Processor classes, anchored on process()", async () => {
    const s = await jsSourcesOf(`import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
export class AudioService {
  constructor(@InjectQueue("audio") private readonly audioQueue: Queue) {}
  transcode() { return this.audioQueue.add("transcode", { file: "a.mp3" }); }
}
@Processor("audio")
export class AudioConsumer extends WorkerHost {
  async process(job) { return job.data; }
}`);
    expect(brief(s)).toEqual(["queue-publish BullMQ: add audio transcode @4", "queue-consume BullMQ: Processor audio @8"]);
  });

  it("leaves add/Worker alone in a file that does not import Bull", async () => {
    const s = await jsSourcesOf(`const q = new Queue("x"); q.add("y"); new Worker("x");`);
    expect(brief(s)).toEqual([]);
  });
});

describe("JS Socket.IO extraction", () => {
  it("emits publish and handlers consume, skipping lifecycle events", async () => {
    const s = await jsSourcesOf(`import { Server } from "socket.io";
const io = new Server(3000);
io.on("connection", (socket) => {
  socket.on("chat message", (msg) => io.emit("chat message", msg));
  socket.on("disconnect", () => {});
});`);
    expect(brief(s)).toEqual(["queue-consume Socket.IO: on chat message @4", "queue-publish Socket.IO: emit chat message @4"]);
  });

  it("reads each listener of a chained .on() as a subscription on the socket", async () => {
    const s = await jsSourcesOf(`import { io } from "socket.io-client";
const websocket = io("", { path: "/api/socket.io" });
websocket
  .on("connect", () => {})
  .on("on_kit_update", (kit) => refresh(kit))
  .on("on_player_transfer", (p) => move(p));`);
    expect(brief(s).sort()).toEqual(["queue-consume Socket.IO: on on_kit_update @5", "queue-consume Socket.IO: on on_player_transfer @6"]);
  });

  it("needs the import: an EventEmitter's emit is not Socket.IO (it is an in-process channel)", async () => {
    const s = await jsSourcesOf(`const socket = new EventEmitter(); socket.emit("chat message", 1);`);
    expect(s.filter((d) => d.name.startsWith("Socket.IO"))).toEqual([]);
    expect(s.filter((d) => d.kind === "queue-publish").map((d) => d.name)).toEqual(["EventEmitter: emit"]);
  });
});

// ─── Python ──────────────────────────────────────────────────────────────────

async function pySourcesOf(body: string): Promise<DataSourceInfo[]> {
  const src = `def go(channel, msg):
${body}
`;
  const tree = await parseSource(src, "python" as any, "x.py");
  return new PythonDataSourceExtractor().extract(tree, src);
}

describe("Python pika extraction", () => {
  it("captures basic_publish exchange + routing key from kwargs", async () => {
    const s = await pySourcesOf(`    channel.basic_publish(exchange='cars', routing_key='car.created', body=msg)`);
    const [p] = publishes(s);
    expect(p!.target).toBe("cars");
    expect(p!.entity).toBe("car.created");
  });

  it("treats pika's default '' exchange as unresolved", async () => {
    const s = await pySourcesOf(`    channel.basic_publish(exchange='', routing_key='tasks', body=msg)`);
    const [p] = publishes(s);
    expect(p!.target).toBeNull();
    expect(p!.entity).toBe("tasks");
  });

  it("captures basic_consume queue kwarg", async () => {
    const s = await pySourcesOf(`    channel.basic_consume(queue='tasks', on_message_callback=handle)`);
    expect(consumes(s)[0]?.target).toBe("tasks");
  });
});

// ─── Java / Kotlin ───────────────────────────────────────────────────────────

async function javaSourcesOf(body: string, methodAnnotation = ""): Promise<DataSourceInfo[]> {
  const src = `package x;
class Svc {
  ${methodAnnotation}
  void m(String payload) {
${body}
  }
}`;
  const tree = await parseSource(src, "java" as any, "Svc.java");
  return new JavaKotlinDataSourceExtractor().extract(tree, src);
}

describe("Java Spring AMQP / Kafka extraction", () => {
  it("captures rabbitTemplate.convertAndSend with a literal exchange", async () => {
    const s = await javaSourcesOf(`    rabbitTemplate.convertAndSend("cars-exchange", "car.created", payload);`);
    expect(publishes(s)[0]?.target).toBe("cars-exchange");
  });

  it("captures kafkaTemplate.send topic", async () => {
    const s = await javaSourcesOf(`    kafkaTemplate.send("player-events", payload);`);
    expect(publishes(s)[0]?.target).toBe("player-events");
  });

  it("ignores send on a non-template receiver", async () => {
    const s = await javaSourcesOf(`    emailService.send("welcome", payload);`);
    expect(publishes(s)).toHaveLength(0);
  });

  it("captures @RabbitListener(queues = ...) as a consume", async () => {
    const s = await javaSourcesOf(`    handle(payload);`, `@RabbitListener(queues = "car-queue")`);
    const [c] = consumes(s);
    expect(c!.name).toBe("@RabbitListener");
    expect(c!.target).toBe("car-queue");
  });

  it("captures @KafkaListener(topics = {\"a\",\"b\"}) destination", async () => {
    const s = await javaSourcesOf(`    handle(payload);`, `@KafkaListener(topics = {"a-events", "b-events"})`);
    expect(consumes(s)[0]?.target).toBe("a-events");
  });
});

// ─── PHP ─────────────────────────────────────────────────────────────────────

async function phpSourcesOf(body: string): Promise<DataSourceInfo[]> {
  const src = `<?php
class W {
  function go($channel, $msg) {
${body}
  }
}`;
  const tree = await parseSource(src, "php" as any, "W.php");
  return new PhpDataSourceExtractor().extract(tree, src);
}

describe("PHP php-amqplib extraction", () => {
  it("captures basic_publish — msg first, THEN exchange and routing key", async () => {
    const s = await phpSourcesOf(`    $channel->basic_publish($msg, 'cars', 'car.created');`);
    const [p] = publishes(s);
    expect(p!.target).toBe("cars");
    expect(p!.entity).toBe("car.created");
  });

  it("captures basic_consume queue", async () => {
    const s = await phpSourcesOf(`    $channel->basic_consume('tasks', '', false, true, false, false, $cb);`);
    expect(consumes(s)[0]?.target).toBe("tasks");
  });
});

describe("PHP curl session collapse (photo-booth noise fix)", () => {
  const api = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "api-call");

  it("emits ONE api-call per curl session, with the CURLOPT_URL target", async () => {
    const s = await phpSourcesOf(`    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, 'https://api.example.com/v1/send');
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $res = curl_exec($ch);
    if (curl_errno($ch)) { $e = curl_error($ch); }
    curl_close($ch);`);
    const calls = api(s);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("curl");
    expect(calls[0]!.target).toBe("https://api.example.com/v1/send");
  });

  it("resolves a URL passed directly to curl_init", async () => {
    const s = await phpSourcesOf(`    $ch = curl_init('https://x.test/y');
    $res = curl_exec($ch);`);
    const calls = api(s);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("https://x.test/y");
  });

  it("keeps file_get_contents only when the argument is a URL literal", async () => {
    const url = await phpSourcesOf(`    $a = file_get_contents('https://x.test/feed.json');`);
    expect(api(url)).toHaveLength(1);
    const file = await phpSourcesOf(`    $b = file_get_contents('/home/certs/swish.pem');`);
    expect(api(file)).toHaveLength(0);
  });
});

async function pyFileSourcesOf(src: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, "python" as any, "x.py");
  return new PythonDataSourceExtractor().extract(tree, src);
}

describe("Python Celery extraction", () => {
  it("a task consumes its own name; .delay, .apply_async and send_task publish to it", async () => {
    const s = await pyFileSourcesOf(`from celery import Celery, shared_task
app = Celery("proj")

@app.task(bind=True, name="proj.tasks.send_email")
def send_email(self, to):
    pass

@shared_task
def resize(path):
    pass

def signup(player):
    send_email.delay(player.email)
    tasks.resize.apply_async(args=[player.avatar])
    app.send_task("proj.tasks.resize", args=[1])
    self.delay(1)
`);
    expect(brief(s)).toEqual([
      "queue-consume Celery: task send_email @5",
      "queue-consume Celery: task resize @9",
      "queue-publish Celery: delay send_email @13",
      "queue-publish Celery: apply_async resize @14",
      "queue-publish Celery: send_task resize @15",
    ]);
  });

  it("a signature kept in a local publishes to the task it signs", async () => {
    const s = await pyFileSourcesOf(`from .tasks import consume_file

def merge(docs):
    consume_task = consume_file.s(docs)
    consume_task.apply_async()
`);
    expect(brief(s)).toEqual(["queue-publish Celery: apply_async consume_file @5"]);
  });

  it("a bare @task (Invoke, Prefect) in a file without Celery is not a task", async () => {
    const s = await pyFileSourcesOf(`from invoke import task

@task
def build(c):
    pass

@flow.task
def other():
    pass
`);
    expect(brief(s)).toEqual([]);
  });
});

describe("JS tRPC client calls", () => {
  it("a procedure chain ending in a query or mutation verb requests its path", async () => {
    const s = await jsSourcesOf(`import { api } from "~/trpc/react";
export function Page() {
  const latest = api.game.latest.useQuery();
  const create = api.game.create.useMutation();
  const utils = api.useUtils();
  utils.game.invalidate();
  void utils.game.byId.fetch(1);
  create.mutate({ title: "x" });
  useQuery(trpc.player.admin.list.queryOptions());
  return null;
}`);
    expect(s.filter((d) => d.kind === "api-call").map((d) => `${d.name} ${d.target}`)).toEqual([
      "GET /trpc/game.latest",
      "POST /trpc/game.create",
      "GET /trpc/game.byId",
      "GET /trpc/player.admin.list",
    ]);
  });

  it("needs a file that names tRPC", async () => {
    const s = await jsSourcesOf(`export function f() { return store.items.list.query(); }`);
    expect(s.filter((d) => d.kind === "api-call")).toEqual([]);
  });
});

describe("JS Drizzle write targets", () => {
  it("names the table a Drizzle insert/update/delete takes, not knex's rows", async () => {
    const s = await jsSourcesOf(`import { db } from "./db";
export async function f(input) {
  await db.insert(Game).values(input);
  await db.update(schema.players).set({ name: "x" }).where(eq(players.id, 1));
  await db.delete(Game).where(eq(Game.id, 1));
  await db.insert(rows);
}`);
    // The chained segments on a trusted `db` root are rows of their own; the verbs name the table.
    expect(s.filter((d) => d.kind === "database" && !d.name.includes("(")).map((d) => `${d.name} ${d.entity ?? "-"}`)).toEqual([
      "db.insert Game", "db.update players", "db.delete Game", "db.insert -",
    ]);
  });
});
