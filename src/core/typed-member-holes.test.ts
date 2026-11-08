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
