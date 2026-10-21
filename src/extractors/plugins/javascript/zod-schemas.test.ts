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
export const createPlayer = z.object({
  email: z.string().email(),
  age: z.number().int().optional(),
  role: z.enum(["admin", "user"]),
  kind: z.literal("person"),
  address: z.object({ city: z.string(), zip: z.string().nullable() }),
  manager: playerRef,
  tags: z.array(z.string()).default([]),
  meta: z.record(z.string(), z.number()),
  scores: z.number().array(),
}).strict();
export const admin = createPlayer.extend({ level: z.number() });
const notASchema = makeBall({ a: 1 });`);
    expect(classes.map((c) => `${c.name}${c.extends ? ` extends ${c.extends}` : ""}: ${c.properties.map((p) => `${p.name}${p.isRequired ? "" : "?"}:${p.type}`).join(", ")}`)).toEqual([
      "createPlayer_address: city:string, zip:string | null",
      "createPlayer: email:string, age?:number, role:'admin' | 'user', kind:'person', address:createPlayer_address, manager:playerRef, tags?:string[], meta:Record<string, number>, scores:number[]",
      "admin extends createPlayer: level:number",
    ]);
  });

  it("names a tRPC procedure's inline input after the procedure", async () => {
    const classes = await schemasOf(`import { z } from "zod";
export const gameRouter = createTRPCRouter({
  byId: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => get(input.id)),
  admin: { purge: protectedProcedure.input(z.object({ before: z.date() })).mutation(() => purge()) },
  count: publicProcedure.input(z.string()).query(() => 1),
});`);
    expect(classes.map((c) => `${c.name}: ${c.properties.map((p) => `${p.name}:${p.type}`).join(", ")}`)).toEqual([
      "gameRouter.byId.input: id:string",
      "gameRouter.admin.purge.input: before:Date",
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
export const createPlayer = Joi.object({
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(0),
  role: Joi.string().valid("admin", "user").required(),
  tags: Joi.array().items(Joi.string()),
  nickname: Joi.string().allow(null, ""),
  address: Joi.object({ city: Joi.string().required() }),
});
export const login = Joi.object().keys({ user: Joi.string().required(), password: Joi.string().required() });
export const admin = createPlayer.keys({ level: Joi.number().required() });`);
    expect(shape(classes)).toEqual([
      "createPlayer_address: city:string",
      "createPlayer: email:string, age?:number, role:'admin' | 'user', tags?:string[], nickname?:string | null, address?:createPlayer_address",
      "login: user:string, password:string",
      "admin extends createPlayer: level:number",
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
export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 256 }).notNull().unique(),
  name: text("name"),
  age: integer("age").notNull().default(0),
  active: boolean("active").notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
});
export const games = pgTable("games", (t) => ({
  id: t.uuid().primaryKey().defaultRandom(),
  title: t.text().notNull(),
}));
`;

  it("an insert needs not-null columns without a default; a select every column; an update none", async () => {
    const classes = await schemasOf(`${tables}
export const insertPlayer = createInsertSchema(players);
export const selectPlayer = createSelectSchema(players);
export const updatePlayer = createUpdateSchema(players);
export const insertGame = createInsertSchema(games);`);
    expect(shape(classes)).toEqual([
      "insertPlayer: id?:number, email:string, name?:string | null, age?:number, active:boolean, createdAt?:string",
      "selectPlayer: id:number, email:string, name:string | null, age:number, active:boolean, createdAt:string",
      "updatePlayer: id?:number, email?:string, name?:string | null, age?:number, active?:boolean, createdAt?:string",
      "insertGame: id?:string, title:string",
    ]);
    expect(classes[0]!.decorators).toEqual(["zod-schema", "drizzle-zod:insert"]);
  });

  it("follows refinements and .omit/.pick/.extend/.partial", async () => {
    const classes = await schemasOf(`${tables}
export const newPlayer = createInsertSchema(players, { email: (s) => s.email(), name: z.string().min(1) }).omit({ id: true, createdAt: true }).extend({ password: z.string() });
export const patchPlayer = createInsertSchema(players).pick({ name: true, age: true }).partial();
export const fromElsewhere = createInsertSchema(clubs);`);
    expect(shape(classes)).toEqual([
      "newPlayer: email:string, name?:string | null, age?:number, active:boolean, password:string",
      "patchPlayer: name?:string | null, age?:number",
    ]);
  });
});

describe("Express bodies validated by a schema", () => {
  it("names the schema from validate(…), zValidator('json', …) and schema.parse(req.body)", async () => {
    const src = `
router.post("/players", validate(createPlayer), (req, res) => res.json(req.body));
app.post("/hono", zValidator("json", createGame), (c) => c.json({}));
router.put("/players/:id", requireAuth, async (req, res) => {
  const body = updatePlayer.parse(req.body);
  res.json(body);
});
router.get("/players/:id", (req, res) => res.json({ id: req.params.id }));
router.post("/raw", handlers.create);
router.post("/checked", validateRequest({ body: createPlayer }), handlers.create);
router.post("/celebrated", celebrate({ [Segments.BODY]: createGame }), handlers.create);
router.post("/joi-validated", validator.body(login), handlers.create);
router.post("/joi-inline", async (req, res) => {
  const { value } = await signup.validateAsync(req.body);
  res.json(value);
});`;
    const tree = await parseSource(src, "typescript" as any, "x.ts");
    const routes: RouteInfo[] = [];
    extractExpressRoutes(tree.rootNode, routes);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${(r.params ?? []).filter((p) => p.binding === "body" && p.type).map((p) => p.type).join(",") || "-"}`)).toEqual([
      "POST /players createPlayer",
      "POST /hono createGame",
      "PUT /players/:id updatePlayer",
      "GET /players/:id -",
      "POST /raw -",
      "POST /checked createPlayer",
      "POST /celebrated createGame",
      "POST /joi-validated login",
      "POST /joi-inline signup",
    ]);
  });
});

describe("yup and TypeBox schemas", () => {
  it("reads yup (optional until required) and TypeBox (required unless Optional) as request types", async () => {
    const { parseSource } = await import("../../../parsers/parser-manager.js");
    const { extractZodSchemas } = await import("./zod-schemas.js");
    const src = `import * as yup from "yup";
import { Type } from "@sinclair/typebox";
export const team = yup.object({ name: yup.string().required(), size: yup.number(), kind: yup.string().oneOf(["a", "b"]).nullable() });
export const member = yup.object().shape({ email: yup.string().email().defined(), roles: yup.array().of(yup.string()) });
export const Tag = Type.Object({ label: Type.String(), color: Type.Optional(Type.String()), kinds: Type.Array(Type.Union([Type.Literal("x"), Type.Literal(2)])) });`;
    const tree = await parseSource(src, "typescript" as never, "s.ts");
    const show = (c: { name: string; properties: Array<{ name: string; type: string | null; isRequired?: boolean }> }) =>
      `${c.name}: ${c.properties.map((p) => `${p.name}${p.isRequired ? "" : "?"}:${p.type}`).join(", ")}`;
    expect(extractZodSchemas(tree.rootNode, src).map(show)).toEqual([
      "team: name:string, size?:number, kind?:'a' | 'b' | null",
      "member: email:string, roles?:string[]",
      "Tag: label:string, color?:string, kinds:'x' | 2[]",
    ]);
  });
});

