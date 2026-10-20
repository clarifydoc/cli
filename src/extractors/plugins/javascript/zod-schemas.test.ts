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

const shape = (classes: Awaited<ReturnType<typeof schemasOf>>) =>
  classes.map((c) => `${c.name}${c.extends ? ` extends ${c.extends}` : ""}: ${c.properties.map((p) => `${p.name}${p.isRequired ? "" : "?"}:${p.type}`).join(", ")}`);

describe("joi schemas", () => {
  it("reads Joi.object and .keys schemas, optional until .required()", async () => {
    const classes = await schemasOf(`import Joi from "joi";
export const createUser = Joi.object({
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(0),
  role: Joi.string().valid("admin", "user").required(),
  tags: Joi.array().items(Joi.string()),
  nickname: Joi.string().allow(null, ""),
  address: Joi.object({ city: Joi.string().required() }),
});
export const login = Joi.object().keys({ user: Joi.string().required(), password: Joi.string().required() });
export const admin = createUser.keys({ level: Joi.number().required() });`);
    expect(shape(classes)).toEqual([
      "createUser_address: city:string",
      "createUser: email:string, age?:number, role:'admin' | 'user', tags?:string[], nickname?:string | null, address?:createUser_address",
      "login: user:string, password:string",
      "admin extends createUser: level:number",
    ]);
    expect(classes[1]!.decorators).toEqual(["joi-schema"]);
  });

  it("takes celebrate's re-exported Joi and a require, and nothing without an import", async () => {
    expect(shape(await schemasOf(`import { celebrate, Joi, Segments } from "celebrate";
const body = Joi.object({ title: Joi.string().required() });`))).toEqual(["body: title:string"]);
    expect(shape(await schemasOf(`const Joi = require("joi");
const body = Joi.object({ n: Joi.number() });`))).toEqual(["body: n?:number"]);
    expect(await schemasOf(`const Joi = lib; const body = Joi.object({ n: Joi.number() });`)).toEqual([]);
  });
});

describe("drizzle-zod schemas", () => {
  const tables = `import { pgTable, serial, text, varchar, integer, timestamp, boolean, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { z } from "zod";
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 256 }).notNull().unique(),
  name: text("name"),
  age: integer("age").notNull().default(0),
  active: boolean("active").notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
});
export const posts = pgTable("posts", (t) => ({
  id: t.uuid().primaryKey().defaultRandom(),
  title: t.text().notNull(),
}));
`;

  it("an insert needs not-null columns without a default; a select every column; an update none", async () => {
    const classes = await schemasOf(`${tables}
export const insertUser = createInsertSchema(users);
export const selectUser = createSelectSchema(users);
export const updateUser = createUpdateSchema(users);
export const insertPost = createInsertSchema(posts);`);
    expect(shape(classes)).toEqual([
      "insertUser: id?:number, email:string, name?:string | null, age?:number, active:boolean, createdAt?:string",
      "selectUser: id:number, email:string, name:string | null, age:number, active:boolean, createdAt:string",
      "updateUser: id?:number, email?:string, name?:string | null, age?:number, active?:boolean, createdAt?:string",
      "insertPost: id?:string, title:string",
    ]);
    expect(classes[0]!.decorators).toEqual(["zod-schema", "drizzle-zod:insert"]);
  });

  it("follows refinements and .omit/.pick/.extend/.partial", async () => {
    const classes = await schemasOf(`${tables}
export const newUser = createInsertSchema(users, { email: (s) => s.email(), name: z.string().min(1) }).omit({ id: true, createdAt: true }).extend({ password: z.string() });
export const patchUser = createInsertSchema(users).pick({ name: true, age: true }).partial();
export const fromElsewhere = createInsertSchema(accounts);`);
    expect(shape(classes)).toEqual([
      "newUser: email:string, name?:string | null, age?:number, active:boolean, password:string",
      "patchUser: name?:string | null, age?:number",
    ]);
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
router.post("/checked", validateRequest({ body: createUser }), handlers.create);
router.post("/celebrated", celebrate({ [Segments.BODY]: createPost }), handlers.create);
router.post("/joi-validated", validator.body(login), handlers.create);
router.post("/joi-inline", async (req, res) => {
  const { value } = await signup.validateAsync(req.body);
  res.json(value);
});`;
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
      "POST /celebrated createPost",
      "POST /joi-validated login",
      "POST /joi-inline signup",
    ]);
  });
});
