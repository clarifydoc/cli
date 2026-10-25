/**
 * The role line at the head of clarifydoc_explain comes from extracted facts —
 * routes, entry points, declared entities, direct data access, outbound calls,
 * call-graph shape — and says nothing when none holds.
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import { buildMcpServer } from "./server.js";
import { inferRoles, roleLine } from "./role.js";

function load(fixture: string) {
  const { server, store } = buildMcpServer({ projectRoot: join("test-fixtures", fixture), analysisDir: join("test-output", fixture), allowAnalyze: false, allowColdStart: false });
  return { server, loaded: store.load() };
}

async function explain(server: ReturnType<typeof buildMcpServer>["server"], args: Record<string, unknown>): Promise<string> {
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_explain", arguments: args } })) as { result: { content: Array<{ text: string }> } };
  return res.result.content[0]!.text;
}

describe("role labels", () => {
  it("names a route handler and a function that queries a table, in explain's second line", async () => {
    const { server } = load("sample-backend");
    const file = await explain(server, { subject: "routes/players.ts" });
    expect(file.split("\n")[1]).toMatch(/^Role: route handler — handles GET \/api\/players, /);
    const fn = await explain(server, { subject: "getPlayerById" });
    expect(fn.split("\n")[1]).toMatch(/^Role: data access — queries player directly, line \d+$/);
  });

  it("names a declared entity a data model, and a table merely queried not one", async () => {
    const { loaded: cqrs } = load("sample-fullstack-cqrs");
    expect(roleLine(await cqrs, { file: "Domain/Owner.cs" })).toMatch(/^Role: data model — ef-core entity Owner \(table owners\), line \d+$/);
    const { loaded: backend } = load("sample-backend");
    expect(inferRoles(await backend, { file: "services/playerService.ts" }).map((a) => a.role)).toEqual(["data access"]);
  });

  it("names a scheduled job and a message consumer by their registration, with what else they do", async () => {
    const { loaded } = load("sample-job-queues");
    const l = await loaded;
    expect(roleLine(l, { file: "node-api/src/cron.ts", symbol: "purgeSessions" })).toMatch(/^Role: scheduled job — registered as "purgeSessions" \(0 3 \* \* \*\) via node-cron · also data access — queries sessions directly/);
    expect(inferRoles(l, { file: "py-app/app/tasks.py", symbol: "generate_report" }).map((a) => a.role)).toEqual(["message consumer", "data access"]);
  });

  it("says nothing for a file no fact classifies", async () => {
    const { loaded } = load("sample-backend");
    expect(roleLine(await loaded, { file: "db/prisma.ts" })).toBeNull();
  });
});
