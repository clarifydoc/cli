import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { denormalizeProject } from "./element-registry.js";
import { readFile } from "fs/promises";

async function project(files: Record<string, string>): Promise<{ dir: string; summary: Record<string, any> }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-url-params-"));
  const root = join(dir, "repo");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return { dir, summary: (await loadReportSummary(join(dir, "out"))) as Record<string, any> };
}

/**
 * A generic repository takes the column it filters on as a parameter (`filter_by(**{key: value})`): each call
 * handing it a string literal names the column for the route parameter it passes.
 */
describe("paramColumns through a generic repository's run-time key, end to end", () => {
  let dir: string;
  let columns: Array<{ route: { path: string; param: string }; column: { field: string; file: string } }>;
  beforeAll(async () => {
    const made = await project({
      "requirements.txt": "fastapi\nsqlalchemy\n",
      "app/models.py": [
        "from sqlalchemy import Column, Integer, String",
        "from sqlalchemy.orm import declarative_base",
        "Base = declarative_base()",
        "",
        "class Club(Base):",
        "    __tablename__ = 'clubs'",
        "    id = Column(Integer, primary_key=True)",
        "    slug = Column(String)",
      ].join("\n"),
      "app/repo.py": [
        "from app.models import Club",
        "",
        "class Repository:",
        "    def __init__(self, session, model):",
        "        self.session = session",
        "        self.model = model",
        "",
        "    def get_one(self, value, key):",
        "        return self.session.query(self.model).filter_by(**{key: value}).first()",
        "",
        "class ClubRepository(Repository):",
        "    def __init__(self, session):",
        "        super().__init__(session, Club)",
      ].join("\n"),
      "app/main.py": [
        "from fastapi import FastAPI, Depends",
        "from app.repo import ClubRepository",
        "",
        "app = FastAPI()",
        "",
        "@app.get('/clubs/{slug}')",
        "def get_club(slug: str, repo: ClubRepository = Depends()):",
        "    return repo.get_one(slug, 'slug')",
        "",
        "@app.get('/clubs/by-id/{club_id}')",
        "def get_club_by_id(club_id: int, repo: ClubRepository = Depends()):",
        "    return repo.get_one(club_id, 'id')",
        "",
        "@app.get('/clubs/by-any/{name}')",
        "def get_club_by_any(name: str, column: str, repo: ClubRepository = Depends()):",
        "    return repo.get_one(name, column)",
      ].join("\n"),
    });
    dir = made.dir;
    columns = made.summary.paramColumns ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the column each call's literal key gives the route parameter", () => {
    const bySlug = columns.filter((c) => c.route.path === "/clubs/{slug}");
    expect(bySlug.map((c) => c.column.field)).toEqual(["slug"]);
    const byId = columns.filter((c) => c.route.path === "/clubs/by-id/{club_id}");
    expect(byId.map((c) => c.column.field)).toEqual(["id"]);
    expect(byId[0]!.column.file).toBe("app/repo.py");
  });

  it("leaves a key that is no literal at the call untyped", () => {
    expect(columns.filter((c) => c.route.path === "/clubs/by-any/{name}")).toEqual([]);
  });
});

const VUE_PACKAGE = JSON.stringify({ name: "league-web", dependencies: { vue: "3.4.0", axios: "1.6.0", express: "4.18.0" } });
const ALIAS = JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } });

/**
 * A Vue handler that sends a request itself is an api-call at the handler's line, and a hole reading a member of
 * a template loop variable is typed by the collection the script declares.
 */
describe("api-calls in a Vue template's expressions, end to end", () => {
  let dir: string;
  let calls: Array<{ line: number; target: string; targetAlternatives?: string[] }>;
  let links: Array<{ url: string; routePath: string; confidence: string }>;
  beforeAll(async () => {
    const made = await project({
      "package.json": VUE_PACKAGE,
      "tsconfig.json": ALIAS,
      "src/types.ts": ["export interface Match { id: number; kind: 'league' | 'cup' }", "export interface Friendly { id: number; kind: 'friendly' }"].join("\n"),
      "src/views/MatchList.vue": [
        "<template>",
        "\t<ul>",
        "\t\t<li v-for=\"m in matches\" :key=\"m.id\">",
        "\t\t\t<button @click=\"axios.post(`/api/${m.kind}/${m.id}/report`)\">Report</button>",
        "\t\t</li>",
        "\t\t<li v-for=\"f in friendlies\" :key=\"f.id\">",
        "\t\t\t<button @click=\"axios.post(`/api/${f.kind}/${f.id}/report`)\">Report</button>",
        "\t\t</li>",
        "\t\t<li v-for=\"x in unknownThings\" :key=\"x.id\">",
        "\t\t\t<button @click=\"axios.post(`/api/${x.kind}/${x.id}/report`)\">Report</button>",
        "\t\t</li>",
        "\t\t<button @click=\"save(); axios.post('/api/league/1/report')\">Both</button>",
        "\t</ul>",
        "</template>",
        "<script setup lang=\"ts\">",
        "import axios from 'axios'",
        "import type {Match, Friendly} from '@/types'",
        "const matches: Match[] = []",
        "const friendlies: Friendly[] = []",
        "const unknownThings = getThings()",
        "function save() {}",
        "</script>",
      ].join("\n"),
      "server/app.js": [
        "const express = require('express')",
        "const app = express()",
        "app.post('/api/league/:id/report', (req, res) => res.json({}))",
        "app.post('/api/cup/:id/report', (req, res) => res.json({}))",
        "app.post('/api/friendly/:id/report', (req, res) => res.json({}))",
        "module.exports = app",
      ].join("\n"),
    });
    dir = made.dir;
    const denorm = denormalizeProject(JSON.parse(await readFile(join(made.dir, "out", "project-summary.json"), "utf-8"))) as unknown as Record<string, any>;
    calls = denorm.apiCalls ?? [];
    links = (denorm.apiRouteLinks ?? []).map((l: any) => ({ url: l.url, routePath: l.routePath, confidence: l.confidence }));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a handler's request as an api-call at its line", () => {
    expect(calls.map((c) => c.line)).toEqual(expect.arrayContaining([4, 7, 10]));
  });

  it("types a hole over a loop variable by the collection the script declares", () => {
    const matches = links.filter((l) => l.url.includes("${m.id}"));
    expect(matches.map((l) => l.routePath).sort()).toEqual(["/api/cup/:id/report", "/api/league/:id/report"]);
    expect(matches.every((l) => l.confidence === "AMBIGUOUS")).toBe(true);
    // The other loop's collection admits one kind: that route, never the first loop's.
    expect(links.filter((l) => l.url.includes("${f.id}")).map((l) => l.routePath)).toEqual(["/api/friendly/:id/report"]);
  });

  it("leaves a loop over an untyped collection a wildcard", () => {
    expect(links.filter((l) => l.url.includes("${x.id}"))).toEqual([]);
  });

  it("leaves a handler of several statements to its calls", () => {
    expect(calls.some((c) => c.line === 12)).toBe(false);
  });
});

/**
 * A template loop variable is the loop's only inside the element carrying its `v-for`: the same name elsewhere in
 * the template is the script's own (a ref or a prop), and the script's types are read at its top level only.
 */
describe("a Vue template loop variable stays inside its element, end to end", () => {
  let dir: string;
  let links: Array<{ url: string; routePath: string; confidence: string }>;
  beforeAll(async () => {
    const made = await project({
      "package.json": VUE_PACKAGE,
      "tsconfig.json": ALIAS,
      "src/types.ts": ["export interface Match { id: number; kind: 'league' | 'cup' }", "export interface Friendly { id: number; kind: 'friendly' }"].join("\n"),
      "src/views/Scoped.vue": [
        "<template>",
        "\t<ul>",
        "\t\t<li v-for=\"club in friendlies\" :key=\"club.id\">",
        "\t\t\t<button @click=\"axios.post(`/api/${club.kind}/${club.id}/inside`)\">In</button>",
        "\t\t</li>",
        "\t\t<button @click=\"axios.post(`/api/${club.kind}/${club.id}/outside`)\">Out</button>",
        "\t</ul>",
        "</template>",
        "<script setup lang=\"ts\">",
        "import axios from 'axios'",
        "import type {Match, Friendly} from '@/types'",
        "const club: Match = getMatch()",
        "const friendlies: Friendly[] = []",
        "</script>",
      ].join("\n"),
      "src/views/Nested.vue": [
        "<template>",
        "\t<ul>",
        "\t\t<li v-for=\"m in matches\" :key=\"m.id\">",
        "\t\t\t<button @click=\"axios.post(`/api/${m.kind}/${m.id}/nested`)\">Go</button>",
        "\t\t</li>",
        "\t\t<li v-for=\"r in rounds\" :key=\"r.id\">",
        "\t\t\t<button @click=\"axios.post(`/api/${r.kind}/${r.id}/nested`)\">Go</button>",
        "\t\t</li>",
        "\t</ul>",
        "</template>",
        "<script setup lang=\"ts\">",
        "import axios from 'axios'",
        "import type {Match, Friendly} from '@/types'",
        "function inner() { const matches: Friendly[] = [] }",
        "const matches: Record<string, Match> = {}",
        "const rounds = defineProps<{ meta: { rounds: Friendly[] }, rounds: Match[] }>()",
        "</script>",
      ].join("\n"),
      "server/app.js": [
        "const express = require('express')",
        "const app = express()",
        "app.post('/api/league/:id/inside', (req, res) => res.json({}))",
        "app.post('/api/cup/:id/inside', (req, res) => res.json({}))",
        "app.post('/api/friendly/:id/inside', (req, res) => res.json({}))",
        "app.post('/api/league/:id/outside', (req, res) => res.json({}))",
        "app.post('/api/cup/:id/outside', (req, res) => res.json({}))",
        "app.post('/api/friendly/:id/outside', (req, res) => res.json({}))",
        "app.post('/api/league/:id/nested', (req, res) => res.json({}))",
        "app.post('/api/friendly/:id/nested', (req, res) => res.json({}))",
        "module.exports = app",
      ].join("\n"),
    });
    dir = made.dir;
    const denorm = denormalizeProject(JSON.parse(await readFile(join(made.dir, "out", "project-summary.json"), "utf-8"))) as unknown as Record<string, any>;
    links = (denorm.apiRouteLinks ?? []).map((l: any) => ({ url: l.url, routePath: l.routePath, confidence: l.confidence }));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("types the loop variable inside its element, never outside it", () => {
    expect(links.filter((l) => l.url.endsWith("/inside")).map((l) => l.routePath)).toEqual(["/api/friendly/:id/inside"]);
    // Outside the loop `club` is the script's `Match`: never the loop's `friendly` kind.
    expect(links.filter((l) => l.url.endsWith("/outside")).map((l) => l.routePath)).not.toContain("/api/friendly/:id/outside");
  });

  it("reads a collection's type at the top level and whole: a generic's comma, a function's own const, a nested member", () => {
    // `matches` is `Record<string, Match>` (no element type the reader names), `rounds` is the top-level props member.
    expect(links.filter((l) => l.url.includes("${m.id}"))).toEqual([]);
    expect(links.filter((l) => l.url.includes("${r.id}")).map((l) => l.routePath).sort()).toEqual(["/api/league/:id/nested"]);
  });
});
