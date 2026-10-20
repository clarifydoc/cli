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

  it("reads block scalars as text: literal lines kept, folded lines joined", () => {
    const doc = parseSimpleYaml([
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - name: Build",
      "        run: |",
      "          docker build -t api ./api",
      "          docker push api",
      "      - run: >-",
      "          kubectl apply",
      "          -f k8s/",
      "    env:",
      "      STAGE: prod",
    ].join("\n"));
    const deploy = (doc.jobs as any).deploy;
    expect(deploy.steps).toEqual([{ name: "Build", run: "docker build -t api ./api\ndocker push api" }, { run: "kubectl apply -f k8s/" }]);
    expect(deploy.env).toEqual({ STAGE: "prod" });
  });

  it("reads a sequence written at its key's own indentation", () => {
    const doc = parseSimpleYaml([
      "jobs:",
      "  test:",
      "    steps:",
      "    - uses: actions/checkout@v4",
      "    - run: npm test",
      "    env:",
      "      CI: 'true'",
      "matrix:",
      "- name:",
      "  os: linux",
      "- os: mac",
      "  arch:",
      "  - arm64",
    ].join("\n"));
    expect((doc.jobs as any).test).toEqual({ steps: [{ uses: "actions/checkout@v4" }, { run: "npm test" }], env: { CI: "true" } });
    expect(doc.matrix).toEqual([{ name: "", os: "linux" }, { os: "mac", arch: ["arm64"] }]);
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

  it("records every compose file that declares a service (stack membership)", async () => {
    const dep = await detectDeployment(root, { subProjects });
    const orders = dep!.services.find((s) => s.name === "orders-api")!;
    expect(orders.composeFiles).toEqual([
      "compose/app-services-compose.yml",
      "compose/rancher-compose.yml",
    ]);
    const billing = dep!.services.find((s) => s.name === "billing-api")!;
    expect(billing.composeFiles).toEqual(["compose/app-services-compose.yml"]);
  });

  it("never turns proxy URL vars into external systems", async () => {
    const dep = await detectDeployment(root, { subProjects });
    // shop-spa carries API_PROXY_URL: ${API_PROXY_URL} — the system's own
    // front door, not an external dependency.
    expect(dep!.externals.some((x) => /proxy/i.test(x.id))).toBe(false);
    expect(dep!.edges.some((e) => /proxy/i.test(e.to))).toBe(false);
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

describe("detectDeployment — vector stores", () => {
  it("classifies a vector database as a datastore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-vector-"));
    try {
      await writeFile(join(dir, "docker-compose.yml"), [
        "services:",
        "  qdrant:",
        "    image: qdrant/qdrant:v1.17.0",
        "  chroma:",
        "    image: chromadb/chroma:latest",
        "  app:",
        "    build: .",
        "",
      ].join("\n"));
      const dep = await detectDeployment(dir, { subProjects: [] });
      const byName = new Map(dep!.services.map((s) => [s.name, s]));
      expect(byName.get("qdrant")).toMatchObject({ kind: "datastore", family: "vector" });
      expect(byName.get("chroma")).toMatchObject({ kind: "datastore", family: "vector" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectDeployment — a compose-only repository", () => {
  it("leaves a service built from a folder this repository does not have to be matched by name", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarifydoc-infra-"));
    try {
      await writeFile(join(root, "docker-compose.yml"), ["services:", "  worker:", "    build: ./worker", "    environment:", "      ORDERS_URL: http://orders:8080", ""].join("\n"));
      const dep = await detectDeployment(root, { subProjects: [{ id: "root", name: "infra", root: "", type: "unknown" } as unknown as SubProject] });
      const worker = dep!.services.find((s) => s.name === "worker")!;
      // Not the infra repo's own root project: the system linker joins it to the repo that holds ./worker.
      expect(worker.project).toBeUndefined();
      expect(worker.urlEnv).toEqual({ ORDERS_URL: "http://orders:8080" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
