import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A receiver with several candidate types — a local built by a factory on each arm of a conditional, a parameter
 * declared `Club | Player` or `Club & Named` — links once per candidate that declares the member, AMBIGUOUS when
 * there are several. A decoy that no arm or member names is never linked, `Club | null` is `Club`, and a factory
 * returning an awaited local is typed as what the local holds.
 */
describe("receivers with several candidate types", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-receiver-candidates-"));
    const file = async (path: string, text: string) => {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    };
    await file("web/package.json", '{"name":"league-web","dependencies":{"axios":"1.6.0"}}');
    await file("server/package.json", '{"name":"league-server","dependencies":{"express":"4.18.0"}}');
    await file("web/src/api/http.ts", 'import axios from "axios";\nexport const http = axios.create({ baseURL: "/api" });\n');
    // ClubApi and PlayerApi share getAll; only ClubApi has reset; GarageApi (decoy) has both but is never named.
    for (const [cls, path, extra] of [
      ["ClubApi", "clubs", "  reset() { return http.post(\"/clubs/reset\"); }\n"],
      ["PlayerApi", "players", ""],
      ["GarageApi", "garages", "  reset() { return http.post(\"/garages/reset\"); }\n"],
      ["Headers", "headers", ""],
    ] as const) {
      await file(
        `web/src/api/${cls}.ts`,
        [
          'import { http } from "./http";',
          `export class ${cls} {`,
          `  getAll() { return http.get("/${path}"); }`,
          extra.trimEnd(),
          "}",
          `export function use${cls}() { return new ${cls}(); }`,
          "",
        ].filter((l) => l !== "").join("\n") + "\n",
      );
    }
    await file("web/src/api/Named.ts", "export class Named {\n  label() { return \"x\"; }\n  ping() { return 1; }\n}\n");
    await file("web/src/api/ClubPing.ts", "export class ClubPing {\n  ping() { return 2; }\n  getAll() { return 3; }\n}\n");
    await file(
      "web/src/api/factory.ts",
      [
        'import { useClubApi } from "./ClubApi";',
        "export async function makeClubApi() {",
        "  const p = useClubApi();",
        "  return await p;",
        "}",
        "",
      ].join("\n"),
    );
    await file(
      "web/src/views/mixed.ts",
      [
        'import { ClubApi, useClubApi } from "../api/ClubApi";',
        'import { PlayerApi, usePlayerApi } from "../api/PlayerApi";',
        'import { Named } from "../api/Named";',
        'import { ClubPing } from "../api/ClubPing";',
        'import { makeClubApi } from "../api/factory";',
        "export function armed(slug: string) {",
        "  const api = slug ? useClubApi() : usePlayerApi();",
        "  api.getAll();",
        "  api.reset();",
        "}",
        "export function branched(slug: string) {",
        "  let api;",
        "  if (slug) { api = useClubApi(); } else { api = usePlayerApi(); }",
        "  api.getAll();",
        "}",
        "export function switched(kind: number) {",
        "  let api;",
        "  switch (kind) {",
        "    case 1: api = useClubApi(); break;",
        "    default: api = usePlayerApi();",
        "  }",
        "  api.getAll();",
        "}",
        "export function fallsThrough(kind: number) {",
        "  let api;",
        "  switch (kind) {",
        "    case 1: api = useClubApi();",
        "    default: api = usePlayerApi();",
        "  }",
        "  api.getAll();",
        "}",
        "export function twoIfs(a: boolean, b: boolean) {",
        "  let api;",
        "  if (a) { api = useClubApi(); }",
        "  if (b) { api = usePlayerApi(); }",
        "  api.getAll();",
        "}",
        "export function noElse(a: boolean) {",
        "  let api;",
        "  if (a) { api = useClubApi(); } else if (!a) { api = usePlayerApi(); }",
        "  api.getAll();",
        "}",
        "export function readBefore(a: boolean) {",
        "  let api;",
        "  api?.getAll();",
        "  if (a) { api = useClubApi(); } else { api = usePlayerApi(); }",
        "}",
        "export function reassignedAfter(a: boolean) {",
        "  let api;",
        "  if (a) { api = useClubApi(); } else { api = usePlayerApi(); }",
        "  api.getAll();",
        "  api = useClubApi();",
        "}",
        "export function unknownArm(slug: string, other: any) {",
        "  const api = slug ? useClubApi() : other.make();",
        "  api.getAll();",
        "}",
        "export function onlyOneDeclares(x: ClubApi | PlayerApi) {",
        "  x.reset();",
        "}",
        "export function both(x: ClubApi | PlayerApi) {",
        "  x.getAll();",
        "}",
        "export function nullable(x: ClubApi | null, y: ClubApi | undefined) {",
        "  x.getAll();",
        "  y.getAll();",
        "}",
        "export function intersect(x: ClubApi & Named) {",
        "  x.label();",
        "  x.getAll();",
        "}",
        "export function intersectBoth(x: Named & ClubPing) {",
        "  x.ping();",
        "}",
        "export function libUnion(x: Headers | ClubApi) {",
        "  x.getAll();",
        "}",
        "export function separate(opt: { relegate: boolean }) {",
        "  if (opt.relegate) { const w = useClubApi(); w.reset(); }",
        "  else { const w = usePlayerApi(); w.getAll(); }",
        "}",
        "export function sameName(opt: { relegate: boolean }) {",
        "  if (opt.relegate) { const w = useClubApi(); w.getAll(); }",
        "  else { const w = usePlayerApi(); w.getAll(); }",
        "}",
        "export function awaited() {",
        "  const c = makeClubApi();",
        "  return c.then((a) => a.getAll());",
        "}",
        "export async function awaited2() {",
        "  const c = await makeClubApi();",
        "  c.getAll();",
        "}",
        "",
      ].join("\n"),
    );
    await file("go/go.mod", "module example.com/league\n\ngo 1.21\n");
    await file(
      "go/league/league.go",
      [
        "package league",
        "",
        "type CoveredGarage struct{}",
        "func (g *CoveredGarage) Close() error { return nil }",
        "func NewCoveredGarage() (*CoveredGarage, error) { return &CoveredGarage{}, nil }",
        "type Garage struct{}",
        "func (g *Garage) Close() error { return nil }",
        "func NewGarage() (*Garage, error) { return &Garage{}, nil }",
        "type Relegation struct{}",
        "func (r *Relegation) Start(o Options) {}",
        "type Promotion struct{}",
        "func (r *Promotion) Start(o Options) {}",
        "type Options struct{ Relegate, Promote bool }",
        "func NewRelegation() *Relegation { return &Relegation{} }",
        "func NewPromotion() *Promotion { return &Promotion{} }",
        "",
      ].join("\n"),
    );
    await file(
      "go/app/garage.go",
      [
        "package app",
        "",
        'import "example.com/league/league"',
        "",
        "func TestGarage(t *testing.T) {",
        '\tt.Run("covered", func(t *testing.T) {',
        "\t\tw, _ := league.NewCoveredGarage()",
        "\t\tw.Close()",
        "\t})",
        '\tt.Run("plain", func(t *testing.T) {',
        "\t\tw, _ := league.NewGarage()",
        "\t\tw.Close()",
        "\t})",
        "}",
        "func StartSeason(opt league.Options) {",
        "\tif opt.Relegate {",
        "\t\tw := league.NewRelegation()",
        "\t\tw.Start(opt)",
        "\t}",
        "\tif opt.Promote {",
        "\t\tw := league.NewPromotion()",
        "\t\tw.Start(opt)",
        "\t}",
        "}",
        "",
      ].join("\n"),
    );
    await file(
      "server/src/app.ts",
      [
        'import express from "express";',
        "const app = express();",
        'app.get("/api/clubs", (req, res) => res.json([]));',
        'app.get("/api/players", (req, res) => res.json([]));',
        "app.listen(3000);",
        "",
      ].join("\n"),
    );
    await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  }, 60_000);
  afterAll(async () => {
    if (!process.env.KEEP) await rm(dir, { recursive: true, force: true }); else process.stderr.write("DIR " + dir + "\n");
  });

  const linksOf = async (fn: string) => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    return (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "web/src/views/mixed.ts" && l.sourceSymbol === fn && l.relation !== "reference");
  };
  const shape = (links: Awaited<ReturnType<typeof linksOf>>, callName: string) =>
    links.filter((l) => l.callName === callName).map((l) => `${l.targetSymbol}:${l.confidence}`).sort();

  it("links a conditional local once per arm, AMBIGUOUS, and never the decoy", async () => {
    const links = await linksOf("armed");
    expect(shape(links, "api.getAll")).toEqual(["ClubApi.getAll:AMBIGUOUS", "PlayerApi.getAll:AMBIGUOUS"]);
    // only one arm's class declares reset
    expect(shape(links, "api.reset").every((s) => s.startsWith("ClubApi.reset"))).toBe(true);
    expect(links.some((l) => l.targetFile.includes("Garage"))).toBe(false);
  });
  it("links a local assigned on each arm of one if/else (or a switch with a default) once per arm, AMBIGUOUS", async () => {
    const want = ["ClubApi.getAll:AMBIGUOUS", "PlayerApi.getAll:AMBIGUOUS"];
    expect(shape(await linksOf("branched"), "api.getAll")).toEqual(want);
    expect(shape(await linksOf("switched"), "api.getAll")).toEqual(want);
  });
  it("leaves a reassigned local untyped when its assignments are no single if/else, or it is read or written outside it", async () => {
    for (const fn of ["fallsThrough", "twoIfs", "noElse", "readBefore", "reassignedAfter"]) {
      expect(shape(await linksOf(fn), "api.getAll")).toEqual([]);
      expect((await linksOf(fn)).some((l) => l.targetFile.includes("Garage"))).toBe(false);
    }
  });
  it("leaves a local with an unresolved arm untyped", async () => {
    expect(shape(await linksOf("unknownArm"), "api.getAll")).toEqual([]);
  });
  it("links a union member declaring the member, one link when only one does", async () => {
    expect(shape(await linksOf("both"), "x.getAll")).toEqual(["ClubApi.getAll:AMBIGUOUS", "PlayerApi.getAll:AMBIGUOUS"]);
    const one = shape(await linksOf("onlyOneDeclares"), "x.reset");
    expect(one.length).toBe(1);
    expect(one[0]).toMatch(/^ClubApi\.reset:/);
  });
  it("keeps Club | null and Club | undefined exactly as Club", async () => {
    const links = await linksOf("nullable");
    expect(shape(links, "x.getAll")).toEqual(["ClubApi.getAll:INFERRED"]);
    expect(shape(links, "y.getAll")).toEqual(["ClubApi.getAll:INFERRED"]);
  });
  it("links the intersection part that declares the member, AMBIGUOUS only when several do", async () => {
    const links = await linksOf("intersect");
    expect(shape(links, "x.label").map((s) => s.split(":")[0])).toEqual(["Named.label"]);
    expect(shape(links, "x.getAll").map((s) => s.split(":")[0])).toEqual(["ClubApi.getAll"]);
    expect(shape(await linksOf("intersectBoth"), "x.ping")).toEqual(["ClubPing.ping:AMBIGUOUS", "Named.ping:AMBIGUOUS"]);
  });
  it("never fans a library type in a union to a project namesake", async () => {
    const links = await linksOf("libUnion");
    expect(links.some((l) => l.targetFile.endsWith("Headers.ts"))).toBe(false);
    expect(shape(links, "x.getAll").every((s) => s.startsWith("ClubApi.getAll"))).toBe(true);
  });
  it("never fans a name declared separately in two blocks to both classes", async () => {
    expect(shape(await linksOf("separate"), "w.reset").every((x) => !x.endsWith("AMBIGUOUS"))).toBe(true);
    expect(shape(await linksOf("sameName"), "w.getAll").every((x) => !x.endsWith("AMBIGUOUS"))).toBe(true);
  });
  it("never fans a Go name declared in two closures or two blocks to both types", async () => {
    const summary = await loadReportSummary(join(dir, ".clarifydoc"));
    const go = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "go/app/garage.go" && (l.callName === "w.Close" || l.callName === "w.Start") && l.relation !== "reference");
    expect(go.filter((l) => l.confidence === "AMBIGUOUS")).toEqual([]);
    // each link, if any, lands on its own block's type: a test double per type would be wrong
    expect(new Set(go.map((l) => `${l.sourceLine}:${l.targetSymbol}`)).size).toBe(go.length);
    for (const l of go) expect(go.filter((o) => o.sourceLine === l.sourceLine).length).toBe(1);
  });
  it("types a factory returning an awaited local as what the local holds", async () => {
    expect(shape(await linksOf("awaited2"), "c.getAll")).toEqual(["ClubApi.getAll:INFERRED"]);
  });
});
