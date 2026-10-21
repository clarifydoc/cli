import { describe, it, expect } from "vitest";
import { buildProjectDependencies, PROJECT_DEPENDENCY_ENDPOINT_CAP } from "./project-dependencies.js";
import type { ApiRouteLink, DeploymentModel, SymbolLink } from "../types/analysis.js";

const link = (sourceProject: string, targetProject: string, routePath: string, extra: Partial<ApiRouteLink> = {}): ApiRouteLink => ({
  source: `${sourceProject}/caller.ts`,
  sourceLine: 1,
  method: "GET",
  url: routePath,
  target: `${targetProject}/Controller.cs`,
  targetLine: 1,
  handler: "h",
  routePath,
  sourceProject,
  targetProject,
  confidence: "EXTRACTED",
  ...extra,
});

const mq = (sourceFile: string, targetFile: string, dest: string): SymbolLink => ({
  sourceFile,
  sourceSymbol: "publish",
  sourceLine: 1,
  callName: `MQ ${dest}`,
  targetFile,
  targetSymbol: "consume",
  targetLine: 1,
  confidence: "INFERRED",
  strategy: "queue",
  relation: "mq",
});

const projectOf = (f: string) => f.split("/")[0];

describe("buildProjectDependencies", () => {
  it("folds cross-project call→route links into one edge per pair, endpoints most-linked first", () => {
    const deps = buildProjectDependencies({
      apiRouteLinks: [
        link("web", "cars", "/api/cars"),
        link("web", "cars", "/api/cars/{id}", { confidence: "INFERRED" }),
        link("web", "cars", "/api/cars/{id}"),
        link("web", "web", "/api/session"),
        link("web", "cars", "/api/legacy", { method: null }),
      ],
      symbolLinks: [],
      projectOf,
    });
    expect(deps).toEqual([
      {
        from: "web",
        to: "cars",
        kind: "http",
        links: 4,
        confidence: { EXTRACTED: 3, INFERRED: 1 },
        endpoints: [
          { name: "GET /api/cars/{id}", links: 2 },
          { name: "/api/legacy", links: 1 },
          { name: "GET /api/cars", links: 1 },
        ],
        endpointCount: 3,
      },
    ]);
  });

  it("leaves out test callers and guesses, keeps generated callers, and skips ends it cannot place", () => {
    const deps = buildProjectDependencies({
      apiRouteLinks: [
        link("e2e", "cars", "/api/cars", { sourceRole: "test" }),
        link("web", "billing", "/api/bills", { confidence: "AMBIGUOUS" }),
        link("sdk", "cars", "/api/cars", { sourceRole: "generated" }),
        { ...link("web", "cars", "/api/cars"), sourceProject: undefined },
      ],
      symbolLinks: [],
      projectOf,
    });
    expect(deps.map((d) => [d.from, d.to, d.links])).toEqual([["sdk", "cars", 1]]);
  });

  it("makes a broker edge from a publish matched to a consumer in another project", () => {
    const deps = buildProjectDependencies({
      apiRouteLinks: [],
      symbolLinks: [
        mq("cars/CarService.cs", "billing/CarSoldConsumer.cs", "car-sold"),
        mq("cars/CarService.cs", "cars/Audit.cs", "car-sold"),
      ],
      projectOf,
    });
    expect(deps).toEqual([
      expect.objectContaining({ from: "cars", to: "billing", kind: "bus", links: 1, endpoints: [{ name: "car-sold", links: 1 }] }),
    ]);
  });

  it("attaches the deployment edge that agrees, and keeps one no code backs at zero links", () => {
    const deployment: DeploymentModel = {
      composeFiles: ["docker-compose.yml"],
      services: [
        { name: "web", composeFile: "docker-compose.yml", kind: "app", project: "web" },
        { name: "cars", composeFile: "docker-compose.yml", kind: "app", project: "cars" },
        { name: "billing", composeFile: "docker-compose.yml", kind: "app", project: "billing" },
        { name: "pgdb", composeFile: "docker-compose.yml", kind: "datastore" },
      ],
      externals: [],
      edges: [
        { from: "web", to: "cars", kind: "http", via: "CARS_URL" },
        { from: "cars", to: "billing", kind: "http", via: "BILLING_URL" },
        { from: "cars", to: "pgdb", kind: "db" },
      ],
    };
    const deps = buildProjectDependencies({
      apiRouteLinks: [link("web", "cars", "/api/cars")],
      symbolLinks: [],
      projectOf,
      deployment,
    });
    expect(deps.map((d) => [d.from, d.to, d.links, d.deployment])).toEqual([
      ["cars", "billing", 0, { via: "BILLING_URL", file: "docker-compose.yml" }],
      ["web", "cars", 1, { via: "CARS_URL", file: "docker-compose.yml" }],
    ]);
  });

  it("caps the endpoint list and keeps the total", () => {
    const many = Array.from({ length: PROJECT_DEPENDENCY_ENDPOINT_CAP + 5 }, (_, i) => link("web", "cars", `/api/r${i}`));
    const [dep] = buildProjectDependencies({ apiRouteLinks: many, symbolLinks: [], projectOf });
    expect(dep!.endpoints).toHaveLength(PROJECT_DEPENDENCY_ENDPOINT_CAP);
    expect(dep!.endpointCount).toBe(PROJECT_DEPENDENCY_ENDPOINT_CAP + 5);
  });
});
