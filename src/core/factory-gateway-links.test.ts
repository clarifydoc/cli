import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A gateway written as `const ClubApi = () => ({ closeClub() { return request(…) } })` and exported as the factory's
 * result — plain (`ClubApi()`) or behind a `new Proxy(ClubApi(), …)` — is used as `useMutation({ mutationFn:
 * LeagueGateway.closeClub })`, `LeagueGateway.getClubs()` or inside a callback. (real-repo FP shape)
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.2.0", "@tanstack/react-query": "5.0.0", express: "4.18.0" } }),
  "web/src/utils/request.ts": "export default async function request(o: { url: string; method?: string }) {\n  const r = await fetch(o.url, { method: o.method ?? 'GET' });\n  return r.json();\n}\n",
  "web/src/gateways/League.gateway.ts": [
    "import request from '../utils/request';",
    "const ClubApi = () => ({",
    "  getClubs() { return request({ url: '/api/clubs' }); },",
    "  closeClub(id: string) { return request({ url: `/api/clubs/${id}`, method: 'DELETE' }); },",
    "});",
    "const LeagueGateway = new Proxy(ClubApi(), { get(t, p, r) { return Reflect.get(t, p, r); } });",
    "export default LeagueGateway;",
  ].join("\n"),
  "web/src/gateways/Plain.gateway.ts": [
    "import request from '../utils/request';",
    "const ClubApi = () => ({ listPlayers() { return request({ url: '/api/players' }); } });",
    "export const PlayerGateway = ClubApi();",
  ].join("\n"),
  // The decoy: the same member names on a gateway nothing serves, and a value that is no factory's result.
  "web/src/other/Garage.gateway.ts": [
    "const ClubApi = () => ({ closeClub() { return 1; }, listPlayers() { return 2; } });",
    "const GarageGateway = ClubApi();",
    "export default GarageGateway;",
  ].join("\n"),
  "web/src/other/Plain.ts": "export const Settings = { closeClub() { return 3; } };\n",
  // A literal that mixes values with its functions (real-repo shape): a gateway holding its base and a retry count,
  // and a controller written as a function declaration whose result the module exports.
  "web/src/gateways/Stand.gateway.ts": [
    "import request from '../utils/request';",
    "const base = '/api/stands';",
    "const StandApi = () => ({",
    "  base,",
    "  retries: 3,",
    "  listStands() { return request({ url: '/api/stands' }); },",
    "});",
    "export default StandApi();",
  ].join("\n"),
  "web/src/menu/pitch.ts": [
    "export function pitchController(label: string) {",
    "  return {",
    "    label,",
    "    size: label.length,",
    "    whistle: () => label.toUpperCase(),",
    "    close() { return label; },",
    "  } as const;",
    "}",
    "export const pitchLeft = pitchController('left');",
  ].join("\n"),
  // The decoy: an exported factory whose RESULT no module exports keeps its literal whole.
  "web/src/other/Kit.ts": "export function kitController() {\n  return { colour: 'red', whistle: () => 1, close() { return 2; } };\n}\n",
  "web/src/Panel.tsx": [
    "import { useMutation } from '@tanstack/react-query';",
    "import LeagueGateway from './gateways/League.gateway';",
    "import { PlayerGateway } from './gateways/Plain.gateway';",
    "import GarageGateway from './other/Garage.gateway';",
    "import { Settings } from './other/Plain';",
    "import StandGateway from './gateways/Stand.gateway';",
    "import { pitchLeft } from './menu/pitch';",
    "import { kitController } from './other/Kit';",
    "export function Panel() {",
    "  const close = useMutation({ mutationFn: LeagueGateway.closeClub });",
    "  const garage = useMutation({ mutationFn: GarageGateway.closeClub });",
    "  const onClose = () => close.mutateAsync('1');",
    "  const onGarage = () => garage.mutate();",
    "  const onSettings = () => Settings.closeClub();",
    "  return <div><button onClick={onClose}>a</button><button onClick={onGarage}>b</button><button onClick={onSettings}>c</button></div>;",
    "}",
    "export const loadClubs = () => LeagueGateway.getClubs();",
    "export const loadPlayers = () => PlayerGateway.listPlayers();",
    "export const loadUnknown = () => LeagueGateway.renameClub();",
    "export const loadStands = () => StandGateway.listStands();",
    "export const blowWhistle = () => pitchLeft.whistle();",
    "export const shutPitch = () => pitchLeft.close();",
    "export const kitWhistle = () => kitController().whistle();",
  ].join("\n"),
  "server/app.js": "const express = require('express');\nconst app = express();\napp.get('/api/clubs', (q, s) => s.json([]));\napp.delete('/api/clubs/:id', (q, s) => s.json({}));\napp.get('/api/players', (q, s) => s.json([]));\napp.get('/api/stands', (q, s) => s.json([]));\n",
};

describe("a gateway exported as a factory's result", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-factory-gateway-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", path)), { recursive: true });
      await writeFile(join(dir, "app", path), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (): string[] => (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "web/src/Panel.tsx").map((l) => `${l.sourceSymbol} -${l.callName}-> ${l.targetFile}#${l.targetSymbol} ${l.confidence}`);

  it("links a call on the exported binding to the factory whose literal states the member", () => {
    expect(rows()).toEqual(expect.arrayContaining([
      "loadClubs -LeagueGateway.getClubs-> web/src/gateways/League.gateway.ts#ClubApi.getClubs INFERRED",
      "loadPlayers -PlayerGateway.listPlayers-> web/src/gateways/Plain.gateway.ts#ClubApi.listPlayers INFERRED",
    ]));
  });

  it("reaches the factory from a mutation whose option names a member of the imported gateway", () => {
    expect(rows()).toEqual(expect.arrayContaining([
      "onClose -close.mutateAsync-> web/src/gateways/League.gateway.ts#ClubApi.closeClub INFERRED",
      "onGarage -garage.mutate-> web/src/other/Garage.gateway.ts#ClubApi.closeClub INFERRED",
    ]));
  });

  it("never links a namesake member to another gateway, nor a member the literal does not state", () => {
    const all = rows();
    // Every link of the decoy's member is to the decoy's own factory, none to the league's.
    expect(all.filter((r) => r.includes("Garage") || r.startsWith("onGarage ")).every((r) => !r.includes("League.gateway") && !r.includes("Plain.gateway"))).toBe(true);
    expect(all.some((r) => r.startsWith("onGarage ") && r.includes("League.gateway"))).toBe(false);
    expect(all.some((r) => r.startsWith("onSettings ") && r.includes("gateways/"))).toBe(false);
    expect(all.some((r) => r.startsWith("loadUnknown ") && r.includes("League.gateway"))).toBe(false);
  });

  it("splits a literal that mixes values with functions when the module exports the factory's result", () => {
    expect(rows()).toEqual(expect.arrayContaining([
      "loadStands -StandGateway.listStands-> web/src/gateways/Stand.gateway.ts#StandApi.listStands INFERRED",
      "blowWhistle -pitchLeft.whistle-> web/src/menu/pitch.ts#pitchController.whistle INFERRED",
      "shutPitch -pitchLeft.close-> web/src/menu/pitch.ts#pitchController.close INFERRED",
    ]));
    const routes = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "web/src/gateways/Stand.gateway.ts" && l.strategy === "api-route").map((l) => `${l.sourceSymbol} ${l.targetSymbol}`);
    expect(routes).toEqual(["StandApi.listStands route:GET /api/stands"]);
    // A value member is no function, and the decoy whose result no module exports keeps its literal whole.
    expect(rows().some((r) => r.includes("#StandApi.base") || r.includes("#StandApi.retries") || r.includes("#pitchController.size"))).toBe(false);
    expect(rows().some((r) => r.startsWith("kitWhistle ") && r.includes("menu/pitch.ts"))).toBe(false);
  });

  it("carries a member's click to its own route only, never to a sibling member's", () => {
    const routesOf = (symbol: string): string[] => (summary.symbolLinks ?? [])
      .filter((l) => l.sourceFile === "web/src/gateways/League.gateway.ts" && l.sourceSymbol === symbol && l.strategy === "api-route")
      .map((l) => l.targetSymbol);
    expect(routesOf("ClubApi.closeClub")).toEqual(["route:DELETE /api/clubs/:id"]);
    expect(routesOf("ClubApi.getClubs")).toEqual(["route:GET /api/clubs"]);
    // The click's handler reaches the member (and so only its route); the factory itself holds no request.
    expect(rows()).toContain("onClose -close.mutateAsync-> web/src/gateways/League.gateway.ts#ClubApi.closeClub INFERRED");
    expect(rows().some((r) => r.startsWith("onClose ") && r.includes("#ClubApi INFERRED"))).toBe(false);
    expect(routesOf("ClubApi")).toEqual([]);
  });
});
