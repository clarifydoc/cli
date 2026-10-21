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
    { name: "cars", composeFile: "docker-compose.yml", kind: "app", project: "cars", urlEnv: { Services__Fleet: "http://fleet:8080" }, hostPorts: [5101] },
    { name: "fleet", composeFile: "docker-compose.yml", kind: "app", project: "fleet", hostPorts: [5102] },
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

const typedClient = (base: HttpClientRegistration["base"]): HttpClientRegistration => ({ client: "FleetClient", scope: "project", base, line: 3 });

describe("resolveCallOrigins", () => {
  it("names nothing when the stated values name two services, and leaves the call as it was", () => {
    const [c] = run(
      [call("cars/FleetClient.cs", "/api/items", { baseExpr: "", baseRef: { kind: "client", key: "FleetClient" } })],
      [analysis("cars/Program.cs", "cars", "csharp", [typedClient({ kind: "config", key: "Services:Fleet" })]), analysis("cars/FleetClient.cs", "cars", "csharp")],
      { cars: [{ key: "Services:Fleet", value: "http://legacy:8080", file: "cars/appsettings.json" }] },
    );
    expect(c!.origin).toMatchObject({ confidence: "AMBIGUOUS" });
    expect(c!.origin).not.toHaveProperty("project");
    expect(c!.baseExpr).toBe("");
  });

  it("never reads a test profile, and takes the code's fallback only when nothing else is stated", () => {
    const noEnv: DeploymentModel = { ...deployment, services: deployment.services.map(({ urlEnv: _u, ...s }) => s) };
    const [c] = run(
      [call("cars/FleetClient.cs", "/api/items", { baseExpr: "", baseRef: { kind: "client", key: "FleetClient" } })],
      [analysis("cars/Program.cs", "cars", "csharp", [typedClient({ kind: "config", key: "Services:Fleet", fallback: "http://localhost:5102" })]), analysis("cars/FleetClient.cs", "cars", "csharp")],
      { cars: [{ key: "Services:Fleet", value: "http://legacy:8080", test: true, file: "cars/appsettings.Test.json" }] },
      noEnv,
    );
    expect(c!.origin).toMatchObject({ project: "fleet", host: "localhost:5102", confidence: "INFERRED" });
    expect(c!.origin!.evidence.map((e) => e.step)).toEqual(["client", "fallback", "address"]);
    expect(c).not.toHaveProperty("baseExpr");
  });

  it("makes a relative call through an outside base absolute, so it never joins a route here", () => {
    const [c] = run(
      [call("cars/Payments.cs", "/v1/charges", { baseExpr: "", baseRef: { kind: "client", key: "Payments" } })],
      [analysis("cars/Payments.cs", "cars", "csharp", [{ client: "Payments", scope: "project", base: { kind: "literal", key: "https://api.stripe.com" }, line: 2 }])],
    );
    expect(c!.origin).toMatchObject({ host: "api.stripe.com", external: true, confidence: "EXTRACTED" });
    expect(c!.target).toBe("https://api.stripe.com/v1/charges");
    expect(c).not.toHaveProperty("baseExpr");
  });

  it("puts the base's path in front of the call's, once", () => {
    const [a, b] = run(
      [
        call("worker/index.ts", "/items", { baseExpr: "process.env.FLEET_URL" }),
        call("worker/index.ts", "/fleet/items", { baseExpr: "process.env.FLEET_URL" }),
      ],
      [analysis("worker/index.ts", "worker", "typescript")],
      {},
      { ...deployment, services: [...deployment.services, { name: "worker", composeFile: "docker-compose.yml", kind: "app", project: "worker", urlEnv: { FLEET_URL: "http://fleet:8080/fleet/" } }] },
    );
    expect([a!.target, b!.target]).toEqual(["/fleet/items", "/fleet/items"]);
    expect(a!.origin).toMatchObject({ project: "fleet", host: "fleet", confidence: "EXTRACTED" });
  });

  it("leaves a local port no service publishes unresolved — the machine is not a service", () => {
    const [c] = run(
      [call("cars/A.cs", "/api/x", { baseExpr: "", baseRef: { kind: "client", key: "A" } })],
      [analysis("cars/A.cs", "cars", "csharp", [{ client: "A", scope: "project", base: { kind: "literal", key: "http://localhost:5999" }, line: 1 }])],
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
    expect(c!.origin).toMatchObject({ project: "fleet", host: "localhost:5102", confidence: "EXTRACTED" });
  });

  it("reads a host left as a hole only by its port, and never surer than INFERRED", () => {
    const [c, d] = run(
      [
        call("web/api.ts", "/api/items", { baseExpr: "http://${IP}:5102" }),
        call("web/api.ts", "/api/items", { baseExpr: "http://${IP}:5999" }),
      ],
      [analysis("web/api.ts", "web", "typescript")],
    );
    expect(c!.origin).toMatchObject({ project: "fleet", confidence: "INFERRED" });
    expect(c).not.toHaveProperty("baseExpr");
    expect(d!.origin).not.toHaveProperty("project");
    expect(d!.baseExpr).toBe("http://${IP}:5999");
  });

  it("forwards a same-origin call through its project's proxy, and no further than a stated service", () => {
    const rules = [
      { pathPrefix: "/api", target: "http://localhost:5102", rewriteTo: "", via: "vite", file: "web/vite.config.ts", project: "web" },
      { pathPrefix: "/ext", target: "https://staging.example.com", via: "vite", file: "web/vite.config.ts", project: "web" },
    ];
    const calls = [call("web/api.ts", "/api/items"), call("web/api.ts", "/ext/items"), call("web/api.ts", "/other")];
    resolveCallOrigins({
      calls,
      analyses: [analysis("web/api.ts", "web", "typescript")],
      importIndex: noImports,
      deployment,
      config: new Map(),
      addresses: buildServiceAddresses(deployment, new Map()),
      proxyRules: rules,
    });
    expect(calls[0]).toMatchObject({ target: "/items", origin: { project: "fleet", confidence: "EXTRACTED" } });
    // A staging host is not one of this analysis's services: nothing changes.
    expect(calls[1]).toMatchObject({ target: "/ext/items" });
    expect(calls[1]).not.toHaveProperty("origin");
    expect(calls[2]).not.toHaveProperty("origin");
  });
});

