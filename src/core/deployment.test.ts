import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { detectDeployment, parseSimpleYaml } from "./deployment.js";
import type { SubProject } from "../types/analysis.js";

// ─── YAML subset parser ─────────────────────────────────────────────────────

describe("parseSimpleYaml", () => {
  it("parses nested maps, scalars and quoted values", () => {
    const doc = parseSimpleYaml([
      "version: '2'",
      "services:",
      "  api:",
      "    image: reg.io/org/api:1.0",
      "    environment:",
      "      KEY: value",
      "      QUOTED: 'single'",
      '      DQUOTED: "double"',
    ].join("\n"));
    const api = (doc.services as any).api;
    expect(api.image).toBe("reg.io/org/api:1.0");
    expect(api.environment.KEY).toBe("value");
    expect(api.environment.QUOTED).toBe("single");
    expect(api.environment.DQUOTED).toBe("double");
  });

  it("keeps values containing colons intact (URLs, rancher labels)", () => {
    const doc = parseSimpleYaml([
      "services:",
      "  api:",
      "    environment:",
      "      ASPNETCORE_URLS: http://*:80",
      "      Url: https://x.y/z?a=1",
      "    labels:",
      "      io.rancher.scheduler.affinity:host_label: type=apps",
    ].join("\n"));
    const api = (doc.services as any).api;
    expect(api.environment.ASPNETCORE_URLS).toBe("http://*:80");
    expect(api.environment.Url).toBe("https://x.y/z?a=1");
    expect(api.labels["io.rancher.scheduler.affinity:host_label"]).toBe("type=apps");
  });

  it("parses inline arrays and block sequences", () => {
    const doc = parseSimpleYaml([
      "services:",
      "  api:",
      '    entrypoint: ["dotnet", "Plan.API.dll"]',
      "    environment:",
      "      - KEY=value",
      "      - OTHER=x=y",
      "    depends_on:",
      "      - db",
      "      - queue",
    ].join("\n"));
    const api = (doc.services as any).api;
    expect(api.entrypoint).toEqual(["dotnet", "Plan.API.dll"]);
    expect(api.environment).toEqual(["KEY=value", "OTHER=x=y"]);
    expect(api.depends_on).toEqual(["db", "queue"]);
  });

  it("strips comments but not # inside quotes", () => {
    const doc = parseSimpleYaml([
      "services: # trailing comment",
      "  api:",
      "    # full-line comment",
      "    image: 'img#tag'",
    ].join("\n"));
    expect((doc.services as any).api.image).toBe("img#tag");
  });
});

// ─── detectDeployment integration ───────────────────────────────────────────

const sub = (id: string, name: string, root: string): SubProject =>
  ({ id, name, root, kind: "dotnet", markers: [] } as SubProject);

describe("detectDeployment", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rd-deploy-"));
    await mkdir(join(root, "compose"), { recursive: true });
    await mkdir(join(root, "compose", "tests"), { recursive: true });

    // Runtime stack: two apps with an api-key handshake, a db, a bus, urls.
    await writeFile(join(root, "compose", "app-services-compose.yml"), [
      "version: '2'",
      "services:",
      "  orders-api:",
      '    entrypoint: ["dotnet", "Orders.API.dll"]',
      "    image: reg.io/org/suite:${TAG}",
      "    environment:",
      "      ApiKeyAuthenticator__ApiKey: ${ORDERS_API_KEY}",
      "      ConnectionString: User ID=${DB_User};Server=db;Database=orders;Password=${DB_Password}",
      "      EventBusConnection: ${EVENTBUS_CONNECTION}",
      "      RedisConnectionString: redis:6379,password=${RedisPassword}",
      "      GraylogUrl: ${GRAYLOG_URL}",
      "  billing-api:",
      '    entrypoint: ["dotnet", "Billing.API.dll"]',
      "    image: reg.io/org/suite:${TAG}",
      "    environment:",
      "      orders-api-key: ${ORDERS_API_KEY}",
      "      ConnectionString: ${BILLING_DB_CONNECTIONSTRING}",
      "      OrdersConnectionString: User ID=${DB_User};Server=db;Database=orders;Password=${DB_Password}",
      "      PayPro__BaseUrl: https://api.paypro.example.com/v2",
      "      TokenIssuer: ${IDP_ISSUER}",
      "  shop-spa:",
      "    image: reg.io/org/shop-spa:${TAG}",
      "    environment:",
      "      API_PROXY_URL: ${API_PROXY_URL}",
      "",
    ].join("\n"));

    await writeFile(join(root, "compose", "infra-compose.yml"), [
      "services:",
      "  pgdb:",
      "    image: reg.io/hub/postgres:16",
      "    environment:",
      "      POSTGRES_MULTIPLE_DATABASES: orders,billing",
      "  rabbitmq:",
      "    image: reg.io/hub/rabbitmq:3.8-management",
      "  redis:",
      "    image: reg.io/hub/redis:latest",
      "",
    ].join("\n"));

    // Metadata-only manifest (rancher style): must not hollow out services.
    await writeFile(join(root, "compose", "rancher-compose.yml"), [
      "services:",
      "  orders-api:",
      "    scale: 2",
      "",
    ].join("\n"));

    // Test stack in a tests/ dir: must be ignored entirely.
    await writeFile(join(root, "compose", "tests", "docker-compose.yml"), [
      "services:",
      "  seeder:",
      '    entrypoint: ["dotnet", "Seeder.dll"]',
      "    image: reg.io/org/suite:${TAG}",
      "",
    ].join("\n"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const subProjects = [
    sub("p-orders", "Orders.API", "src/Orders/Orders.API"),
    sub("p-billing", "Billing.API", "src/Billing/Billing.API"),
    sub("p-spa", "ShopSPA", "Frontend/ShopSPA"),
  ];

  it("collects runtime services, skips test stacks, classifies infra", async () => {
    const dep = await detectDeployment(root, { subProjects });
    expect(dep).toBeDefined();
    const names = dep!.services.map((s) => s.name).sort();
    expect(names).toEqual(["billing-api", "orders-api", "pgdb", "rabbitmq", "redis", "shop-spa"]);
    const byName = new Map(dep!.services.map((s) => [s.name, s]));
    expect(byName.get("pgdb")!.kind).toBe("datastore");
    expect(byName.get("pgdb")!.family).toBe("postgres");
    expect(byName.get("pgdb")!.hostedDatabases).toEqual(["orders", "billing"]);
    expect(byName.get("rabbitmq")!.kind).toBe("queue");
    expect(byName.get("redis")!.kind).toBe("cache");
  });

  it("matches services to sub-projects via entrypoint dll and image tail", async () => {
    const dep = await detectDeployment(root, { subProjects });
    const byName = new Map(dep!.services.map((s) => [s.name, s]));
    expect(byName.get("orders-api")!.project).toBe("p-orders");
    expect(byName.get("billing-api")!.project).toBe("p-billing");
    expect(byName.get("shop-spa")!.project).toBe("p-spa"); // shop-spa ≈ ShopSPA
  });

  it("keeps image/entrypoint when a metadata-only manifest declares the service first", async () => {
    const dep = await detectDeployment(root, { subProjects });
    const orders = dep!.services.find((s) => s.name === "orders-api")!;
    expect(orders.entrypoint).toContain("Orders.API.dll");
    expect(orders.tech).toBe("Orders.API");
  });

  it("derives the api-key handshake edge (consumer → provider)", async () => {
    const dep = await detectDeployment(root, { subProjects });
    expect(dep!.edges).toContainEqual(
      expect.objectContaining({ from: "billing-api", to: "orders-api", kind: "http", via: "ORDERS_API_KEY" }),
    );
  });

  it("derives db edges literal-first, marks cross-database access, skips cache/bus conn strings", async () => {
    const dep = await detectDeployment(root, { subProjects });
    const orders = dep!.services.find((s) => s.name === "orders-api")!;
    // Literal Database=orders wins over the ${DB_User} credential placeholder.
    expect(orders.databases).toEqual([{ name: "orders", primary: true }]);
    const billing = dep!.services.find((s) => s.name === "billing-api")!;
    // Own db from the var name, foreign db (orders) from the decorated key.
    expect(billing.databases).toContainEqual({ name: "billing", primary: true });
    expect(billing.databases).toContainEqual({ name: "orders", primary: false });
    // RedisConnectionString must NOT become a database.
    expect(orders.databases!.some((d) => d.name.includes("redis"))).toBe(false);
    expect(dep!.edges).toContainEqual(
      expect.objectContaining({ from: "billing-api", to: "pgdb", kind: "db", label: "orders" }),
    );
    expect(dep!.edges).toContainEqual(
      expect.objectContaining({ from: "orders-api", to: "pgdb", kind: "db", label: "orders" }),
    );
  });

  it("attaches bus services to the queue and flags cache users", async () => {
    const dep = await detectDeployment(root, { subProjects });
    const orders = dep!.services.find((s) => s.name === "orders-api")!;
    expect(orders.bus).toBe(true);
    expect(orders.cache).toBe(true);
    expect(dep!.edges).toContainEqual(
      expect.objectContaining({ from: "orders-api", to: "rabbitmq", kind: "bus" }),
    );
  });

  it("collects externals from literal URLs, URL placeholders and issuers", async () => {
    const dep = await detectDeployment(root, { subProjects });
    const extIds = dep!.externals.map((x) => x.id);
    expect(extIds).toContain("ext:paypro");       // PayPro__BaseUrl literal
    expect(extIds).toContain("ext:graylog");      // GRAYLOG_URL placeholder
    expect(extIds).toContain("ext:idp");          // IDP_ISSUER
    const payproEdge = dep!.edges.find((e) => e.to === "ext:paypro");
    expect(payproEdge).toMatchObject({ from: "billing-api", kind: "external" });
    const paypro = dep!.externals.find((x) => x.id === "ext:paypro")!;
    expect(paypro.url).toBe("https://api.paypro.example.com/v2");
  });

  it("returns undefined when no compose files exist", async () => {
    const empty = await mkdtemp(join(tmpdir(), "rd-empty-"));
    try {
      expect(await detectDeployment(empty, { subProjects: [] })).toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
