import { describe, it, expect } from "vitest";
import { envVarName, joinEnvVars } from "./env-vars.js";
import type { DeploymentModel, FileAnalysis } from "../types/analysis.js";

describe("environment variables", () => {
  it("names the variable each reader reads, and nothing that is not one", () => {
    expect([
      { name: "ORDERS_URL", target: "process.env.ORDERS_URL" },
      { name: "VITE_API", target: "import.meta.env.VITE_API" },
      { name: "os.getenv", target: "DATABASE_URL" },
      { name: "os.Getenv", target: "PORT" },
      { name: "GetEnvironmentVariable", target: "ORDERS_DB" },
      { name: "getenv", target: "JWT_SECRET" },
      { name: "Ini.ReadString", target: "Sync" },
      { name: "getProperty", target: "user.home" },
      { name: "os.getenv", target: null },
    ].map(envVarName)).toEqual(["ORDERS_URL", "VITE_API", "DATABASE_URL", "PORT", "ORDERS_DB", "JWT_SECRET", null, null, null]);
  });

  it("joins a variable to the services of the reader's own project that set it", () => {
    const file = (filePath: string, projectId: string, env: Array<[string, string]>) =>
      ({ filePath, projectId, dataSources: env.map(([name, target], i) => ({ kind: "env", name, target, line: i + 1, calls: [] })) }) as unknown as FileAnalysis;
    const deployment = { services: [
      { name: "orders", composeFile: "docker-compose.yml", composeFiles: ["docker-compose.yml"], kind: "app", project: "orders", envKeys: ["DATABASE_URL", "PORT"] },
      { name: "billing", composeFile: "docker-compose.yml", composeFiles: ["docker-compose.yml"], kind: "app", project: "billing", envKeys: ["PORT"] },
      { name: "worker", composeFile: "worker/Dockerfile", kind: "app", dockerfile: "worker/Dockerfile", envKeys: ["QUEUE"] },
    ], edges: [], externals: [] } as unknown as DeploymentModel;
    const uses = joinEnvVars([
      file("orders/db.ts", "orders", [["DATABASE_URL", "process.env.DATABASE_URL"], ["PORT", "process.env.PORT"]]),
      file("billing/main.py", "billing", [["os.getenv", "STRIPE_KEY"]]),
      file("worker/run.go", "worker", [["os.Getenv", "QUEUE"]]),
      file("gen/x.ts", "orders", [["PORT", "process.env.PORT"]]),
    ], deployment, (f) => !f.startsWith("gen/"));
    expect(uses.map((u) => `${u.name}: ${u.readBy.map((r) => r.file).join(",")} ← ${u.setBy.map((s) => `${s.service} (${s.file})`).join(", ") || "—"}`)).toEqual([
      "DATABASE_URL: orders/db.ts ← orders (docker-compose.yml)",
      "PORT: orders/db.ts ← orders (docker-compose.yml)",
      "QUEUE: worker/run.go ← worker (worker/Dockerfile)",
      "STRIPE_KEY: billing/main.py ← —",
    ]);
  });
});
