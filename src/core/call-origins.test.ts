import { describe, it, expect } from "vitest";
import { resolveCallOrigins } from "./call-origins.js";
import { buildServiceAddresses } from "./service-addresses.js";
import type { DataSourceInfo, DeploymentModel, FileAnalysis, HttpClientRegistration } from "../types/analysis.js";
import type { ProjectConfigValue } from "./config-values.js";

const noImports = { localFor: () => null, sourceFor: () => null, namespacesFor: () => [] };

const analysis = (filePath: string, projectId: string, language: "csharp" | "typescript", regs: HttpClientRegistration[] = []) =>
  ({ filePath, projectId, language, httpClientRegistrations: regs }) as unknown as FileAnalysis;

const call = (filePath: string, target: string, extra: Partial<DataSourceInfo> = {}) =>
  ({ kind: "api-call", name: "GetAsync", target, line: 1, calls: [], filePath, ...extra }) as DataSourceInfo & { filePath: string };

const deployment: DeploymentModel = {
  composeFiles: ["docker-compose.yml"],
  services: [
    { name: "orders", composeFile: "docker-compose.yml", kind: "app", project: "orders", urlEnv: { Services__Inventory: "http://inventory:8080" }, hostPorts: [5101] },
    { name: "inventory", composeFile: "docker-compose.yml", kind: "app", project: "inventory", hostPorts: [5102] },
    { name: "legacy", composeFile: "docker-compose.yml", kind: "app", project: "legacy" },
  ],
  externals: [],
  edges: [],
};

function run(calls: Array<DataSourceInfo & { filePath: string }>, analyses: FileAnalysis[], config: Record<string, ProjectConfigValue[]> = {}, dep = deployment) {
  const configMap = new Map(Object.entries(config));
  resolveCallOrigins({
    calls,
    analyses,
    importIndex: noImports,
    deployment: dep,
    config: configMap,
    addresses: buildServiceAddresses(dep, configMap),
  });
  return calls;
}

const typedClient = (base: HttpClientRegistration["base"]): HttpClientRegistration => ({ client: "InventoryClient", scope: "project", base, line: 3 });

describe("resolveCallOrigins", () => {
  it("names nothing when the stated values name two services, and leaves the call as it was", () => {
    const [c] = run(
      [call("orders/InventoryClient.cs", "/api/items", { baseExpr: "", baseRef: { kind: "client", key: "InventoryClient" } })],
      [analysis("orders/Program.cs", "orders", "csharp", [typedClient({ kind: "config", key: "Services:Inventory" })]), analysis("orders/InventoryClient.cs", "orders", "csharp")],
      { orders: [{ key: "Services:Inventory", value: "http://legacy:8080", file: "orders/appsettings.json" }] },
    );
    expect(c!.origin).toMatchObject({ confidence: "AMBIGUOUS" });
    expect(c!.origin).not.toHaveProperty("project");
    expect(c!.baseExpr).toBe("");
  });

  it("never reads a test profile, and takes the code's fallback only when nothing else is stated", () => {
    const noEnv: DeploymentModel = { ...deployment, services: deployment.services.map(({ urlEnv: _u, ...s }) => s) };
    const [c] = run(
      [call("orders/InventoryClient.cs", "/api/items", { baseExpr: "", baseRef: { kind: "client", key: "InventoryClient" } })],
      [analysis("orders/Program.cs", "orders", "csharp", [typedClient({ kind: "config", key: "Services:Inventory", fallback: "http://localhost:5102" })]), analysis("orders/InventoryClient.cs", "orders", "csharp")],
      { orders: [{ key: "Services:Inventory", value: "http://legacy:8080", test: true, file: "orders/appsettings.Test.json" }] },
      noEnv,
    );
    expect(c!.origin).toMatchObject({ project: "inventory", host: "localhost:5102", confidence: "INFERRED" });
    expect(c!.origin!.evidence.map((e) => e.step)).toEqual(["client", "fallback", "address"]);
    expect(c).not.toHaveProperty("baseExpr");
  });

  it("makes a relative call through an outside base absolute, so it never joins a route here", () => {
    const [c] = run(
      [call("orders/Payments.cs", "/v1/charges", { baseExpr: "", baseRef: { kind: "client", key: "Payments" } })],
      [analysis("orders/Payments.cs", "orders", "csharp", [{ client: "Payments", scope: "project", base: { kind: "literal", key: "https://api.stripe.com" }, line: 2 }])],
    );
    expect(c!.origin).toMatchObject({ host: "api.stripe.com", external: true, confidence: "EXTRACTED" });
    expect(c!.target).toBe("https://api.stripe.com/v1/charges");
    expect(c).not.toHaveProperty("baseExpr");
  });

  it("puts the base's path in front of the call's, once", () => {
    const [a, b] = run(
      [
        call("worker/index.ts", "/items", { baseExpr: "process.env.INVENTORY_URL" }),
        call("worker/index.ts", "/inv/items", { baseExpr: "process.env.INVENTORY_URL" }),
      ],
      [analysis("worker/index.ts", "worker", "typescript")],
      {},
      { ...deployment, services: [...deployment.services, { name: "worker", composeFile: "docker-compose.yml", kind: "app", project: "worker", urlEnv: { INVENTORY_URL: "http://inventory:8080/inv/" } }] },
    );
    expect([a!.target, b!.target]).toEqual(["/inv/items", "/inv/items"]);
    expect(a!.origin).toMatchObject({ project: "inventory", host: "inventory", confidence: "EXTRACTED" });
  });

  it("leaves a local port no service publishes unresolved — the machine is not a service", () => {
    const [c] = run(
      [call("orders/A.cs", "/api/x", { baseExpr: "", baseRef: { kind: "client", key: "A" } })],
      [analysis("orders/A.cs", "orders", "csharp", [{ client: "A", scope: "project", base: { kind: "literal", key: "http://localhost:5999" }, line: 1 }])],
    );
    expect(c!.origin).toMatchObject({ host: "localhost:5999", confidence: "INFERRED" });
    expect(c!.origin).not.toHaveProperty("project");
    expect(c!.origin).not.toHaveProperty("external");
  });

  it("resolves a loopback origin by the port a service publishes or listens on", () => {
    const [c] = run(
      [call("web/api.ts", "/api/items", { baseRef: { kind: "literal", key: "http://localhost:5102" } })],
      [analysis("web/api.ts", "web", "typescript")],
    );
    expect(c!.origin).toMatchObject({ project: "inventory", host: "localhost:5102", confidence: "EXTRACTED" });
  });

  it("reads a host left as a hole only by its port, and never surer than INFERRED", () => {
    const [c, d] = run(
      [
        call("web/api.ts", "/api/items", { baseExpr: "http://${IP}:5102" }),
        call("web/api.ts", "/api/items", { baseExpr: "http://${IP}:5999" }),
      ],
      [analysis("web/api.ts", "web", "typescript")],
    );
    expect(c!.origin).toMatchObject({ project: "inventory", confidence: "INFERRED" });
    expect(c).not.toHaveProperty("baseExpr");
    expect(d!.origin).not.toHaveProperty("project");
    expect(d!.baseExpr).toBe("http://${IP}:5999");
  });
});

