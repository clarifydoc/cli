import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";

describe("what a handler answers", () => {
  it("reads Express, Fastify and Hono responses with their status and literal keys", async () => {
    const src = `
export async function show(req, res) {
  const player = await repo.find(req.params.id);
  if (!player) return res.status(404).json({ error: "not found" });
  res.json({ id: player.id, name: player.name });
}
export async function create(req, reply) { return reply.code(201).send({ ok: true }); }
export const remove = async (req, res) => { await repo.del(req.params.id); res.sendStatus(204); };
export const list = (c) => c.json({ items: [], ...meta }, 200);
export function helper(a, b) { return b.json({ x: 1 }); }`;
    const tree = await parseSource(src, "typescript" as any, "players.ts");
    const fns = new JavaScriptExtractor().extractFunctions(tree, src);
    const of = (n: string) => fns.find((f) => f.name === n)?.responses;
    expect(of("show")).toEqual([{ status: 404, keys: ["error"] }, { status: null, keys: ["id", "name"] }]);
    expect(of("create")).toEqual([{ status: 201, keys: ["ok"] }]);
    expect(of("remove")).toEqual([{ status: 204 }]);
    // A spread hides keys: the shape is not all written.
    expect(of("list")).toEqual([{ status: 200 }]);
    expect(of("helper")).toBeUndefined();
  });
});

describe("what a caller reads off a response", () => {
  const readsOf = async (src: string) => {
    const tree = await parseSource(src, "typescript" as any, "api.ts");
    return new JavaScriptDataSourceExtractor().extract(tree, src).filter((d) => d.kind === "api-call").map((d) => `${d.target} ${(d.responseReads ?? []).join(",") || "-"}`);
  };

  it("follows fetch's json(), axios's data and destructuring; arrays' members are not fields", async () => {
    expect(await readsOf(`
export async function a(id) { const res = await fetch(\`/players/\${id}\`); const player = await res.json(); return player.name + player?.email; }
export async function b() { const res = await fetch("/stats"); const { total, active: on } = await res.json(); return total + on; }
export async function c() { const { data } = await axios.get("/items"); return data.items.map((i) => i.id).concat(data.length); }
export async function d() { const res = await api.get("/cars"); return res.data.count; }
export async function e() { return fetch("/raw").then((r) => r.json()); }`)).toEqual([
      "/players/${id} email,name",
      "/stats active,total",
      "/items items",
      "/cars count",
      "/raw -",
    ]);
  });
});
