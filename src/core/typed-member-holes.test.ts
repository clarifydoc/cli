/**
 * A URL hole reading a member of a typed parameter (`${item.entityType}`, `item: Favorite`) whose declared
 * type is a closed set of strings — a literal union written in place or through an alias, or an enum of
 * string values — names each of those values: every route a value reaches links AMBIGUOUS, and a route no
 * value names is not linked.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { extractTsTypeAliases } from "../extractors/plugins/javascript/type-aliases.js";
import "../extractors/registry.js";
import { parseSource } from "../parsers/parser-manager.js";
import type { ApiRouteLink } from "../types/analysis.js";

const FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0" } }),
  "web/src/types/favorite.ts": [
    "export type FavoriteKind = 'clubs' | 'players';",
    "export interface Favorite { id: number; entityType: FavoriteKind; label: string }",
    "export enum TrophyKind { League = 'leagues', Cup = 'cups' }",
    "export interface Trophy { id: number; kind: TrophyKind }",
    "export interface Shortlist { id: number; section: 'clubs' | 'coaches' | null }",
  ].join("\n"),
  "web/src/api/favorites.ts": [
    "import axios from 'axios';",
    "import type { Favorite, Trophy } from '../types/favorite';",
    "export function removeFavorite(item: Favorite) {",
    "  return axios.delete(`/api/v1/${item.entityType}/${item.id}`);",
    "}",
    "export function loadTrophy(trophy: Trophy) {",
    "  return axios.get(`/api/v1/${trophy.kind}/${trophy.id}`);",
    "}",
    "export function renameFavorite(item: Favorite) {",
    "  return axios.put(`/api/v1/${item.label}/${item.id}`);",
    "}",
    "export function exportFavorite(wide: boolean, item: Favorite) {",
    "  const endpoint = wide ? 'leagues' : item.entityType;",
    "  return axios.get(`/api/v1/${endpoint}/export`);",
    "}",
  ].join("\n"),
  "web/src/views/ShortlistView.vue": [
    "<template>",
    "  <button @click=\"drop(entry)\">Drop</button>",
    "</template>",
    "<script setup lang=\"ts\">",
    "import axios from 'axios';",
    "import type { Shortlist } from '../types/favorite';",
    "async function drop(entry: Shortlist) {",
    "  await axios.delete(`/api/v1/${entry.section}/${entry.id}`);",
    "}",
    "</script>",
  ].join("\n"),
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "^4.18.0" } }),
  "api/src/server.js": [
    "const express = require('express');",
    "const app = express();",
    "app.delete('/api/v1/clubs/:id', (req, res) => res.sendStatus(204));",
    "app.delete('/api/v1/players/:id', (req, res) => res.sendStatus(204));",
    "app.delete('/api/v1/coaches/:id', (req, res) => res.sendStatus(204));",
    "app.put('/api/v1/clubs/:id', (req, res) => res.sendStatus(204));",
    "app.put('/api/v1/players/:id', (req, res) => res.sendStatus(204));",
    "app.get('/api/v1/leagues/:id', (req, res) => res.json({}));",
    "app.get('/api/v1/cups/:id', (req, res) => res.json({}));",
    "app.get('/api/v1/stadiums/:id', (req, res) => res.json({}));",
    "app.get('/api/v1/leagues/export', (req, res) => res.json({}));",
    "app.get('/api/v1/clubs/export', (req, res) => res.json({}));",
    "app.get('/api/v1/players/export', (req, res) => res.json({}));",
    "app.get('/api/v1/coaches/export', (req, res) => res.json({}));",
    "app.listen(3000);",
  ].join("\n"),
};

describe("a URL hole over a typed member", () => {
  let dir: string;
  let links: ApiRouteLink[] = [];
  const linked = (file: string, line: number) =>
    links.filter((l) => l.source === file && l.sourceLine === line).map((l) => [l.method, l.routePath, l.confidence]).sort();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "typed-member-holes-"));
    for (const [rel, src] of Object.entries(FILES)) {
      await mkdir(join(dir, "src", dirname(rel)), { recursive: true });
      await writeFile(join(dir, "src", rel), src);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false } as never);
    links = (await loadReportSummary(join(dir, "out"))).apiRouteLinks ?? [];
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names each value of a string-literal alias, AMBIGUOUS, and not the decoy", () => {
    expect(linked("web/src/api/favorites.ts", 4)).toEqual([
      ["DELETE", "/api/v1/clubs/:id", "AMBIGUOUS"],
      ["DELETE", "/api/v1/players/:id", "AMBIGUOUS"],
    ]);
  });

  it("names each string value of an enum", () => {
    expect(linked("web/src/api/favorites.ts", 7)).toEqual([
      ["GET", "/api/v1/cups/:id", "AMBIGUOUS"],
      ["GET", "/api/v1/leagues/:id", "AMBIGUOUS"],
    ]);
  });

  it("names each literal of a union written on the field, in a Vue component", () => {
    expect(linked("web/src/views/ShortlistView.vue", 8)).toEqual([
      ["DELETE", "/api/v1/clubs/:id", "AMBIGUOUS"],
      ["DELETE", "/api/v1/coaches/:id", "AMBIGUOUS"],
    ]);
  });

  it("expands the typed arm of a choice beside a literal one", () => {
    expect(linked("web/src/api/favorites.ts", 14)).toEqual([
      ["GET", "/api/v1/clubs/export", "AMBIGUOUS"],
      ["GET", "/api/v1/leagues/export", "AMBIGUOUS"],
      ["GET", "/api/v1/players/export", "AMBIGUOUS"],
    ]);
  });

  it("leaves a member typed as any string a wildcard", () => {
    expect(linked("web/src/api/favorites.ts", 10)).toEqual([]);
  });
});

describe("TypeScript type aliases", () => {
  it("keeps a union of string literals as written, and no union of other types", async () => {
    const tree = await parseSource([
      "export type FavoriteKind = 'clubs' | 'players';",
      "type Section = | 'clubs' | 'coaches' | null;",
      "type One = 'clubs';",
      "type Mixed = 'clubs' | number;",
      "type Garage = Car | null;",
    ].join("\n"), "typescript" as never, "kinds.ts");
    expect(extractTsTypeAliases(tree).map((a) => [a.name, a.type])).toEqual([
      ["FavoriteKind", "'clubs' | 'players'"],
      ["Section", "'clubs' | 'coaches' | null"],
      ["Garage", "Car"],
    ]);
  });
});

const REACH: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { vue: "^3.4.0", axios: "^1.6.0" } }),
  "web/src/types.ts": [
    "export type Division = 'premier' | 'cup';",
    "export type Venue = 'stadium' | 'academy';",
    "export interface Sponsor { tier: Division }",
    "export interface Club { id: number; division: Division; sponsor: Sponsor }",
    "export interface Facility { division: Venue; sponsor: { tier: Venue } }",
  ].join("\n"),
  "web/src/api.ts": [
    "import axios from 'axios';",
    "import type { Club, Division, Facility } from './types';",
    "export function inline(item: { division: Division; label?: string }) {",
    "  return axios.get(`/api/${item.division}/table`);",
    "}",
    "export function nested(club: Club) {",
    "  return axios.get(`/api/${club.sponsor.tier}/table`);",
    "}",
    "export function loop(clubs: Club[]) {",
    "  for (const c of clubs) {",
    "    axios.get(`/api/${c.division}/table`);",
    "  }",
    "}",
    "export function each(clubs: Club[]) {",
    "  clubs.forEach((c) => {",
    "    axios.get(`/api/${c.division}/table`);",
    "  });",
    "}",
    "export class TableApi {",
    "  club!: Club;",
    "  clubs: Club[] = [];",
    "  grounds: Facility[] = [];",
    "  own() {",
    "    return axios.get(`/api/${this.club.division}/table`);",
    "  }",
    "  ownNested() {",
    "    return axios.get(`/api/${this.club.sponsor.tier}/table`);",
    "  }",
    "  loopField() {",
    "    for (const c of this.clubs) {",
    "      axios.get(`/api/${c.division}/table`);",
    "    }",
    "  }",
    "  loopDecoy() {",
    "    for (const g of this.grounds) {",
    "      axios.get(`/api/${g.division}/table`);",
    "    }",
    "  }",
    "  eachDecoy() {",
    "    this.grounds.forEach((g) => axios.get(`/api/${g.sponsor.tier}/table`));",
    "  }",
    "}",
    "export function unknownMember(club: Club) {",
    "  return axios.get(`/api/${club.sponsor.name}/table`);",
    "}",
    "export function wrapped(item: {",
    "  division:",
    "    | 'premier'",
    "    | 'cup';",
    "}) {",
    "  return axios.get(`/api/${item.division}/table`);",
    "}",
    "export function listed(items: { division: Division }[]) {",
    "  return axios.get(`/api/${items.division}/table`);",
    "}",
  ].join("\n"),
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "^4.18.0" } }),
  "api/src/server.js": [
    "const express = require('express');",
    "const app = express();",
    ...["premier", "cup", "stadium", "academy"].map((d) => `app.get('/api/${d}/table', (req, res) => res.json([]));`),
    "app.listen(3000);",
  ].join("\n"),
};

describe("a URL hole over an inline type, a nested member, a field or a loop element", () => {
  let dir: string;
  let links: ApiRouteLink[] = [];
  const reached = (line: number) =>
    links.filter((l) => l.source === "web/src/api.ts" && l.sourceLine === line).map((l) => [l.routePath, l.confidence]).sort();
  const premierCup = [["/api/cup/table", "AMBIGUOUS"], ["/api/premier/table", "AMBIGUOUS"]];
  const venues = [["/api/academy/table", "AMBIGUOUS"], ["/api/stadium/table", "AMBIGUOUS"]];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "typed-member-holes-reach-"));
    for (const [rel, src] of Object.entries(REACH)) {
      await mkdir(join(dir, "src", dirname(rel)), { recursive: true });
      await writeFile(join(dir, "src", rel), src);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false } as never);
    links = (await loadReportSummary(join(dir, "out"))).apiRouteLinks ?? [];
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a receiver typed by an inline object type", () => {
    expect(reached(4)).toEqual(premierCup);
  });

  it("reads a nested member through each declared property type", () => {
    expect(reached(7)).toEqual(premierCup);
  });

  it("types the element of a loop or callback over a typed collection parameter", () => {
    expect(reached(11)).toEqual(premierCup);
    expect(reached(16)).toEqual(premierCup);
  });

  it("reads this.field.member and this.field.a.b through the class's field types", () => {
    expect(reached(24)).toEqual(premierCup);
    expect(reached(27)).toEqual(premierCup);
  });

  it("types the element of a loop over a typed field, and uses no same-named member of another type", () => {
    expect(reached(31)).toEqual(premierCup);
    expect(reached(36)).toEqual(venues);
    expect(reached(40)).toEqual(venues);
  });

  it("leaves a member the type does not declare a wildcard", () => {
    expect(reached(44)).toEqual([]);
  });

  it("reads an inline type wrapped over lines, and not a collection of objects as an object", () => {
    expect(reached(51)).toEqual(premierCup);
    expect(reached(54)).toEqual([]);
  });
});

const CALLS: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { axios: "^1.6.0" } }),
  "web/src/api.ts": [
    "import axios from 'axios';",
    "export type Division = 'premier' | 'cup';",
    "export interface Club { division: Division }",
    "export interface Facility { division: 'stadium' | 'academy' }",
    "export class ClubRepo { all(): Club[] { return []; } }",
    "export class GroundRepo { all(): Facility[] { return []; } }",
    "export function loopResult(repo: ClubRepo) {",
    "  for (const c of repo.all()) {",
    "    axios.get(`/api/${c.division}/table`);",
    "  }",
    "}",
    "export function loopGround(repo: GroundRepo) {",
    "  for (const g of repo.all()) {",
    "    axios.get(`/api/${g.division}/table`);",
    "  }",
    "}",
    "export function clubsNow(): Club[] { return []; }",
    "export function loopFree() {",
    "  for (const c of clubsNow()) {",
    "    axios.get(`/api/${c.division}/table`);",
    "  }",
    "}",
    "export class Registry {",
    "  static club: Club;",
    "  static pick() {",
    "    return axios.get(`/api/${this.club.division}/table`);",
    "  }",
    "}",
    "export class Instance {",
    "  club!: Club;",
    "  static decoy() {",
    "    return axios.get(`/api/${this.club.division}/table`);",
    "  }",
    "  fine() {",
    "    return axios.get(`/api/${this.club.division}/table`);",
    "  }",
    "}",
  ].join("\n"),
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "^4.18.0" } }),
  "api/src/server.js": [
    "const express = require('express');",
    "const app = express();",
    ...["premier", "cup", "stadium", "academy"].map((d) => `app.get('/api/${d}/table', (req, res) => res.json([]));`),
    "app.listen(3000);",
  ].join("\n"),
};

describe("a URL hole over the result of a call, and over this in a static method", () => {
  let dir: string;
  let links: ApiRouteLink[] = [];
  const reached = (line: number) =>
    links.filter((l) => l.source === "web/src/api.ts" && l.sourceLine === line).map((l) => [l.routePath, l.confidence]).sort();
  const premierCup = [["/api/cup/table", "AMBIGUOUS"], ["/api/premier/table", "AMBIGUOUS"]];
  const venues = [["/api/academy/table", "AMBIGUOUS"], ["/api/stadium/table", "AMBIGUOUS"]];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "typed-member-holes-calls-"));
    for (const [rel, src] of Object.entries(CALLS)) {
      await mkdir(join(dir, "src", dirname(rel)), { recursive: true });
      await writeFile(join(dir, "src", rel), src);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false } as never);
    links = (await loadReportSummary(join(dir, "out"))).apiRouteLinks ?? [];
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a loop element by the return type of the method it iterates, on the receiver's own class", () => {
    expect(reached(9)).toEqual(premierCup);
    expect(reached(14)).toEqual(venues);
  });

  it("types a loop element by the return type of a free function", () => {
    expect(reached(20)).toEqual(premierCup);
  });

  it("reads this in a static method as the class, whose static fields are the only ones it has", () => {
    expect(reached(26)).toEqual(premierCup);
    expect(reached(32)).toEqual([]);
    expect(reached(35)).toEqual(premierCup);
  });
});

/**
 * A loop over an awaited call reads the element of the result a declared `Promise<Club[]>` resolves to, and
 * `this` inside a plain `function` (whose `this` the caller binds) is never the class around it.
 */
const ASYNC_FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { axios: "^1.6.0" } }),
  "web/src/types.ts": [
    "export type ClubKind = 'league' | 'cup';",
    "export interface Club { id: number; kind: ClubKind }",
    "export type CarKind = 'sport' | 'city';",
    "export interface Car { id: number; kind: CarKind }",
  ].join("\n"),
  "web/src/awaited.ts": [
    "import axios from 'axios';",
    "import type { Club, Car } from './types';",
    "class ClubRepo {",
    "  async all(): Promise<Club[]> { return []; }",
    "}",
    "class CarRepo {",
    "  async all(): Promise<Car[]> { return []; }",
    "}",
    "export async function syncClubs(repo: ClubRepo) {",
    "  for (const c of await repo.all()) {",
    "    await axios.get(`/api/items/${c.kind}`);",
    "  }",
    "}",
    "export async function syncCars(repo: CarRepo) {",
    "  for (const c of await repo.all()) {",
    "    await axios.get(`/api/items/${c.kind}`);",
    "  }",
    "}",
  ].join("\n"),
  "web/src/nested.ts": [
    "import axios from 'axios';",
    "import type { Car } from './types';",
    "class CarSync {",
    "  static car: Car;",
    "  static run() {",
    "    const go = function () {",
    "      return axios.get(`/api/items/${this.car.kind}`);",
    "    };",
    "    return go();",
    "  }",
    "  static direct() {",
    "    return axios.get(`/api/items/${this.car.kind}`);",
    "  }",
    "  static viaArrow() {",
    "    const go = () => axios.get(`/api/items/${this.car.kind}`);",
    "    return go();",
    "  }",
    "}",
  ].join("\n"),
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "^4.18.0" } }),
  "api/src/server.js": [
    "const express = require('express');",
    "const app = express();",
    "app.get('/api/items/league', (req, res) => res.json({}));",
    "app.get('/api/items/cup', (req, res) => res.json({}));",
    "app.get('/api/items/friendly', (req, res) => res.json({}));",
    "app.get('/api/items/sport', (req, res) => res.json({}));",
    "app.get('/api/items/city', (req, res) => res.json({}));",
    "app.listen(3000);",
  ].join("\n"),
};

describe("a URL hole over an awaited loop and over this in a nested plain function", () => {
  let dir: string;
  let links: ApiRouteLink[] = [];
  const reached = (file: string, line: number) =>
    [...new Set(links.filter((l) => l.source === file && l.sourceLine === line && l.routePath.startsWith("/api/items/") && !l.routePath.includes("+")).map((l) => l.routePath))].sort();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "typed-member-holes-async-"));
    for (const [rel, src] of Object.entries(ASYNC_FILES)) {
      await mkdir(join(dir, "src", dirname(rel)), { recursive: true });
      await writeFile(join(dir, "src", rel), src);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false } as never);
    links = (await loadReportSummary(join(dir, "out"))).apiRouteLinks ?? [];
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types the element of `for (const c of await repo.all())` by the awaited declared result, each repository its own", () => {
    expect(reached("web/src/awaited.ts", 11)).toEqual(["/api/items/cup", "/api/items/league"]);
    expect(reached("web/src/awaited.ts", 16)).toEqual(["/api/items/city", "/api/items/sport"]);
  });

  it("leaves this in a plain function a wildcard, but reads it in a static method and through an arrow", () => {
    expect(reached("web/src/nested.ts", 7)).toEqual([]);
    expect(reached("web/src/nested.ts", 12)).toEqual(["/api/items/city", "/api/items/sport"]);
    expect(reached("web/src/nested.ts", 15)).toEqual(["/api/items/city", "/api/items/sport"]);
  });
});

const MODULE_FILES: Record<string, string> = {
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { axios: "^1.6.0" } }),
  "web/src/types.ts": [
    "export type ClubKind = 'league' | 'cup';",
    "export interface Club { id: number; kind: ClubKind }",
    "export type CarKind = 'sport' | 'city';",
    "export interface Car { id: number; kind: CarKind }",
  ].join("\n"),
  "web/src/clubRepo.ts": [
    "import type { Club } from './types';",
    "export class ClubRepo {",
    "  all(): Club[] { return []; }",
    "  async load(): Promise<Club[]> { return []; }",
    "}",
  ].join("\n"),
  "web/src/carRepo.ts": [
    "import type { Car } from './types';",
    "export class CarRepo {",
    "  all(): Car[] { return []; }",
    "}",
  ].join("\n"),
  // A module-level receiver names its type once, for every function below.
  "web/src/module.ts": [
    "import axios from 'axios';",
    "import { ClubRepo } from './clubRepo';",
    "import { CarRepo } from './carRepo';",
    "const repo = new ClubRepo();",
    "const cars = new CarRepo();",
    "export function syncClubs() {",
    "  for (const c of repo.all()) axios.get(`/api/items/${c.kind}`);",
    "}",
    "export async function loadClubs() {",
    "  for (const c of await repo.load()) axios.get(`/api/items/${c.kind}`);",
    "}",
    "export function syncCars() {",
    "  cars.all().forEach((c) => axios.get(`/api/items/${c.kind}`));",
    "}",
    "export function shadowed(repo: CarRepo) {",
    "  for (const c of repo.all()) axios.get(`/api/items/${c.kind}`);",
    "}",
    "export function shadowedByCall(make: () => unknown) {",
    "  const repo = make();",
    "  for (const c of repo.all()) axios.get(`/api/items/${c.kind}`);",
    "}",
    "export function shadowedByArrow(list: any[]) {",
    "  list.forEach((repo) => { for (const c of repo.all()) axios.get(`/api/items/${c.kind}`); });",
    "}",
    "export function shadowedNested(list: any[][]) {",
    "  list.forEach((row) => row.forEach((repo) => { for (const c of repo.all()) axios.get(`/api/items/${c.kind}`); }));",
    "}",
    "let late: ClubRepo;",
    "describe('club sync', () => {",
    "  beforeEach(() => { late = new ClubRepo(); });",
    "  it('loads', () => {",
    "    for (const c of late.all()) axios.get(`/api/items/${c.kind}`);",
    "  });",
    "});",
    "export function outer() {",
    "  const inner = () => { const repo = make(); return repo; };",
    "  for (const c of repo.all()) axios.get(`/api/items/${c.kind}`);",
    "}",
  ].join("\n"),
  // Collections the file writes as object literals: the strings written are the values.
  "web/src/literals.ts": [
    "import axios from 'axios';",
    "const kinds = [{ kind: 'league' }, { kind: 'cup' }];",
    "const frozen = [{ kind: 'sport' }, { kind: 'city' }] as const;",
    "const mixed = [{ kind: 'league' }, { other: 1 }];",
    "const computed = [{ kind: 'league' }, { kind: String(Math.random()) }];",
    "const spread = [{ kind: 'league', ...extra }, { kind: 'cup' }];",
    "const grown = [{ kind: 'league' }];",
    "grown.push({ kind: 'cup' });",
    "const wrapped = [",
    "  { kind: 'sport' },",
    "  { kind: 'city' },",
    "];",
    "export function fromModule() {",
    "  for (const k of kinds) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function fromFrozen() {",
    "  frozen.forEach((k) => axios.get(`/api/items/${k.kind}`));",
    "}",
    "export function fromLocal() {",
    "  const own = [{ kind: 'friendly' }, { kind: 'cup' }];",
    "  for (const k of own) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function unevenLiteral() {",
    "  for (const k of mixed) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function computedLiteral() {",
    "  for (const k of computed) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function parameter(items: any[]) {",
    "  for (const k of items) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function shadowedParam(kinds: any[]) {",
    "  for (const k of kinds) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function spreadLiteral() {",
    "  for (const k of spread) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function grownLiteral() {",
    "  for (const k of grown) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function wrappedLiteral() {",
    "  for (const k of wrapped) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function shadowedLoopVariable(groups: any[][]) {",
    "  for (const kinds of groups) for (const k of kinds) axios.get(`/api/items/${k.kind}`);",
    "}",
    "export function shadowedDestructured(load: () => { kinds: any[] }) {",
    "  const { kinds } = load();",
    "  for (const k of kinds) axios.get(`/api/items/${k.kind}`);",
    "}",
  ].join("\n"),
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "^4.18.0" } }),
  "api/src/server.js": [
    "const express = require('express');",
    "const app = express();",
    ...["league", "cup", "friendly", "sport", "city", "other"].map((k) => `app.get('/api/items/${k}', (req, res) => res.json({}));`),
    "app.listen(3000);",
  ].join("\n"),
};

describe("a URL hole over a module-level receiver and over a collection the file writes", () => {
  let dir: string;
  let links: ApiRouteLink[] = [];
  const reached = (file: string, line: number) =>
    [...new Set(links.filter((l) => l.source === file && l.sourceLine === line && l.routePath.startsWith("/api/items/") && !l.routePath.includes("+")).map((l) => l.routePath))].sort();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "typed-member-holes-module-"));
    for (const [rel, src] of Object.entries(MODULE_FILES)) {
      await mkdir(join(dir, "src", dirname(rel)), { recursive: true });
      await writeFile(join(dir, "src", rel), src);
    }
    await analyze({ projectRoot: join(dir, "src"), outputDir: join(dir, "out"), lsp: false, gitHistory: false } as never);
    links = (await loadReportSummary(join(dir, "out"))).apiRouteLinks ?? [];
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types a loop over a call on a module-level receiver by that call's declared result, each class its own", () => {
    expect(reached("web/src/module.ts", 7)).toEqual(["/api/items/cup", "/api/items/league"]);
    expect(reached("web/src/module.ts", 10)).toEqual(["/api/items/cup", "/api/items/league"]);
    expect(reached("web/src/module.ts", 13)).toEqual(["/api/items/city", "/api/items/sport"]);
  });

  it("lets a parameter or a call-initialized local of the name hide the module's receiver", () => {
    expect(reached("web/src/module.ts", 16)).toEqual(["/api/items/city", "/api/items/sport"]);
    expect(reached("web/src/module.ts", 20)).toEqual([]);
    // A callback's own parameter named like the module's receiver is not that receiver.
    expect(reached("web/src/module.ts", 23)).toEqual([]);
    expect(reached("web/src/module.ts", 26)).toEqual([]);
    // A plain assignment in a nested callback writes the module's `late`, which keeps its declared type.
    expect(reached("web/src/module.ts", 32)).toEqual(["/api/items/cup", "/api/items/league"]);
    // A nested function's own `const repo` does not hide the module's from the function around it.
    expect(reached("web/src/module.ts", 37)).toEqual(["/api/items/cup", "/api/items/league"]);
  });

  it("reads the strings an array of object literals writes, at module level, `as const`, local or wrapped over lines", () => {
    expect(reached("web/src/literals.ts", 14)).toEqual(["/api/items/cup", "/api/items/league"]);
    expect(reached("web/src/literals.ts", 17)).toEqual(["/api/items/city", "/api/items/sport"]);
    expect(reached("web/src/literals.ts", 21)).toEqual(["/api/items/cup", "/api/items/friendly"]);
    expect(reached("web/src/literals.ts", 42)).toEqual(["/api/items/city", "/api/items/sport"]);
  });

  it("leaves a literal collection that does not write the member everywhere, writes it open (a spread, a push, a computed value), is hidden by a parameter or destructuring, or is untyped, a wildcard", () => {
    for (const line of [24, 27, 30, 33, 36, 39, 45, 49]) expect(reached("web/src/literals.ts", line)).toEqual([]);
  });
});
