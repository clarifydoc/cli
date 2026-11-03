import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";

/** The database rows of a TypeScript file, as `[name, table, access, line]`. */
async function dbOf(src: string): Promise<Array<[string, string | null, string | undefined, number]>> {
  const tree = await parseSource(src, "typescript" as any, "x.ts");
  return new JavaScriptDataSourceExtractor()
    .extract(tree, src)
    .filter((d) => d.kind === "database")
    .map((d) => [d.name, d.target, d.access, d.line]);
}

describe("JS SQL template tags name their tables", () => {
  it("postgres.js: the client a `postgres(url)` call builds", async () => {
    expect(await dbOf(`import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL);
export async function listCars(make: string) {
  return sql\`select id from cars where make = \${make}\`;
}
export async function addCar(make: string) {
  await sql\`insert into cars (make) values (\${make})\`;
}`)).toEqual([
      ["sql", "cars", "read", 4],
      ["sql", "cars", "write", 7],
    ]);
  });

  it("postgres.js under another name, and its `unsafe` tag", async () => {
    expect(await dbOf(`import postgres from "postgres";
const db = postgres(url);
export const garages = () => db\`SELECT * FROM garages\`;
export const wipe = () => db.unsafe\`DELETE FROM garages\`;`)).toEqual([
      ["db", "garages", "read", 3],
      ["db.unsafe", "garages", "write", 4],
    ]);
  });

  it("@vercel/postgres and @neondatabase/serverless", async () => {
    expect(await dbOf(`import { sql } from "@vercel/postgres";
export async function matches() {
  const { rows } = await sql\`SELECT * FROM matches\`;
  return rows;
}`)).toEqual([["sql", "matches", "read", 3]]);
    expect(await dbOf(`import { neon } from "@neondatabase/serverless";
const query = neon(process.env.DATABASE_URL!);
export const fixtures = () => query\`SELECT f.id FROM fixtures f JOIN clubs c ON c.id = f.home_id\`;`)).toEqual([
      ["query", "fixtures", "read", 3],
      ["query", "clubs", "read", 3],
    ]);
  });

  it("slonik, drizzle-orm and kysely `sql` tags", async () => {
    expect(await dbOf(`import { sql } from "slonik";
export const managers = (pool) => pool.any(sql.type(Manager)\`SELECT * FROM managers\`);`)).toContainEqual(["sql.type", "managers", "read", 2]);
    expect(await dbOf(`import { sql } from "drizzle-orm";
export const referees = () => db.execute(sql\`select * from referees\`);`)).toContainEqual(["sql", "referees", "read", 2]);
    expect(await dbOf(`import { sql } from "kysely";
export const stadiums = (db) => sql\`update stadiums set capacity = 0\`.execute(db);`)).toContainEqual(["sql", "stadiums", "write", 2]);
  });

  it("Prisma `$queryRaw` / `$executeRaw` read like `$queryRawUnsafe`", async () => {
    expect(await dbOf(`export async function squad(id: number) {
  const a = await prisma.$queryRaw\`SELECT * FROM players WHERE club_id = \${id}\`;
  await prisma.$executeRaw\`UPDATE players SET fit = true\`;
  const b = await prisma.$queryRawUnsafe("SELECT * FROM players");
}`)).toEqual([
      ["prisma.$queryRaw", "players", "read", 2],
      ["prisma.$executeRaw", "players", "write", 3],
      ["prisma.$queryRawUnsafe", "players", "read", 4],
    ]);
  });

  it("a tag with type arguments, which tree-sitter-typescript misparses", async () => {
    expect(await dbOf(`import postgres from "postgres";
const sql = postgres(url);
export async function clubs() {
  const a = await sql<{ id: string }[]>\`select id from clubs\`;
  const b = await sql<Club>\`select id from leagues\`;
  const c = await prisma.$queryRaw<Player[]>\`SELECT * FROM players\`;
  const d = await prisma.$queryRaw<Player>\`SELECT * FROM transfers\`;
  return [a, b, c, d];
}`)).toEqual([
      ["sql", "clubs", "read", 4],
      ["sql", "leagues", "read", 5],
      ["prisma.$queryRaw", "players", "read", 6],
      ["prisma.$queryRaw", "transfers", "read", 7],
    ]);
  });

  it("leaves alone: fragments, other tags, a comparison of a template", async () => {
    expect(await dbOf(`import { sql } from "drizzle-orm";
import { t } from "./i18n";
export const older = sql\`\${players.age} > 30\`;
export const label = t\`Select a car from the garage\`;
export const page = html\`<p>select from the list</p>\`;
export const odd = (a, b) => a < b > \`select id from clubs\`;`)).toEqual([]);
  });
});
