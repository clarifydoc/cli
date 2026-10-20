import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractZodSchemas } from "./zod-schemas.js";
import { extractExpressRoutes } from "./routes/express.js";
import type { RouteInfo } from "../../../types/analysis.js";

async function schemasOf(src: string) {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return extractZodSchemas(tree.rootNode, src);
}

describe("zod schemas", () => {
  it("a named z.object is a class whose fields carry TypeScript type spellings", async () => {
    const classes = await schemasOf(`import { z } from "zod";
export const createUser = z.object({
  email: z.string().email(),
  age: z.number().int().optional(),
  role: z.enum(["admin", "user"]),
  kind: z.literal("person"),
  address: z.object({ city: z.string(), zip: z.string().nullable() }),
  manager: userRef,
  tags: z.array(z.string()).default([]),
  meta: z.record(z.string(), z.number()),
  scores: z.number().array(),
}).strict();
export const admin = createUser.extend({ level: z.number() });
const notASchema = makeThing({ a: 1 });`);
    expect(classes.map((c) => `${c.name}${c.extends ? ` extends ${c.extends}` : ""}: ${c.properties.map((p) => `${p.name}${p.isRequired ? "" : "?"}:${p.type}`).join(", ")}`)).toEqual([
      "createUser_address: city:string, zip:string | null",
      "createUser: email:string, age?:number, role:'admin' | 'user', kind:'person', address:createUser_address, manager:userRef, tags?:string[], meta:Record<string, number>, scores:number[]",
      "admin extends createUser: level:number",
    ]);
  });

  it("names a tRPC procedure's inline input after the procedure", async () => {
    const classes = await schemasOf(`import { z } from "zod";
export const postRouter = createTRPCRouter({
  byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => get(input.id)),
  admin: { purge: protectedProcedure.input(z.object({ before: z.date() })).mutation(() => purge()) },
  count: publicProcedure.input(z.string()).query(() => 1),
});`);
    expect(classes.map((c) => `${c.name}: ${c.properties.map((p) => `${p.name}:${p.type}`).join(", ")}`)).toEqual([
      "postRouter.byId.input: id:string",
      "postRouter.admin.purge.input: before:Date",
    ]);
  });

  it("reads nothing in a file that does not import zod", async () => {
    expect(await schemasOf(`const z = lib; export const s = z.object({ a: z.string() });`)).toEqual([]);
  });
});

describe("Express bodies validated by a schema", () => {
  it("names the schema from validate(…), zValidator('json', …) and schema.parse(req.body)", async () => {
    const src = `
router.post("/users", validate(createUser), (req, res) => res.json(req.body));
app.post("/hono", zValidator("json", createPost), (c) => c.json({}));
router.put("/users/:id", requireAuth, async (req, res) => {
  const body = updateUser.parse(req.body);
  res.json(body);
});
router.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
router.post("/raw", handlers.create);
router.post("/checked", validateRequest({ body: createUser }), handlers.create);`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const routes: RouteInfo[] = [];
    extractExpressRoutes(tree.rootNode, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${(r.params ?? []).filter((p) => p.binding === "body" && p.type).map((p) => p.type).join(",") || "-"}`)).toEqual([
      "POST /users createUser",
      "POST /hono createPost",
      "PUT /users/:id updateUser",
      "GET /users/:id -",
      "POST /raw -",
      "POST /checked createUser",
    ]);
  });
});
