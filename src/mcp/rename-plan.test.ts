/**
 * clarifydoc_rename_plan: exact spans for a definition and its callers, and a refusal (no partial plan) when
 * a caller line is not certain, an override stands in the way, or the name is taken.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { buildMcpServer } from "./server.js";
import { Sources, registrationSpan } from "./tools/rename-plan.js";

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "league", version: "1.0.0" }),
  "src/club.ts": [
    "export class Club {",
    "  signPlayer(name: string) {",
    "    return name;",
    "  }",
    "}",
    "export class YouthClub extends Club {",
    "  signPlayer(name: string) {",
    "    return name + '!';",
    "  }",
    "}",
    "export function playMatch(home: string) {",
    "  return home;",
    "}",
    "export function playTwice(home: string) {",
    "  return home;",
    "}",
    "",
  ].join("\n"),
  "src/season.ts": [
    "import { playMatch, playTwice } from './club';",
    "export function openSeason() {",
    "  const first = playMatch('A');",
    "  return playMatch('B') + first;",
    "}",
    "export function openCup() {",
    "  // playTwice is only named in this comment",
    "  return playTwice('C') + playTwice('D');",
    "}",
    "export function twice() {",
    "  return playTwice('E') + playMatch('F');",
    "}",
    "",
  ].join("\n"),
};

let dir = "";
let server: ReturnType<typeof buildMcpServer>["server"];

async function plan(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = (await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_rename_plan", arguments: args } })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { text: res.result.content[0]!.text, isError: !!res.result.isError };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarifydoc-rename-"));
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  server = buildMcpServer({ projectRoot: dir, analysisDir: join(dir, "out"), allowAnalyze: true, analyzeSettings: { gitHistory: false }, log: () => {} }).server;
  await server.handleMessage({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "clarifydoc_analyze", arguments: {} } });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("clarifydoc_rename_plan", () => {
  it("lists the definition and each caller at the columns of the name", async () => {
    const { text, isError } = await plan({ symbol: "playMatch", to: "hostMatch" });
    expect(isError).toBe(false);
    expect(text).toContain("Nothing is written");
    const spans = [...text.matchAll(/^- (\S+?):(\d+):(\d+)-(\d+)$/gm)];
    expect(spans.length).toBeGreaterThanOrEqual(3);
    for (const [, file, line, start, end] of spans) {
      const row = readFileSync(join(dir, file!), "utf-8").split("\n")[Number(line) - 1]!;
      expect(row.slice(Number(start) - 1, Number(end) - 1)).toBe("playMatch");
    }
    expect(text).toMatch(/Imports and exports naming it/);
    expect(text).toContain("Dynamic uses");
  });

  it("refuses with the rows when a caller line holds the name twice", async () => {
    const { text } = await plan({ symbol: "playTwice", to: "playCup" });
    expect(text).toContain("Refused — no plan");
    expect(text).toContain("src/season.ts:8");
    expect(text).toContain("written 2 times");
    expect(text).not.toContain("Callers (");
  });

  it("refuses a method an override stands behind", async () => {
    const { text } = await plan({ symbol: "Club.signPlayer", to: "recruit" });
    expect(text).toContain("Refused — no plan");
    expect(text).toMatch(/overrides or implements it|declared above it/);
  });

  it("refuses a name that is not an identifier, and a name already taken", async () => {
    expect((await plan({ symbol: "playMatch", to: "host match" })).isError).toBe(true);
    const taken = await plan({ symbol: "playMatch", to: "playTwice" });
    expect(taken.text).toContain("already exists beside it");
  });

  it("says when nothing is named so", async () => {
    const { text, isError } = await plan({ symbol: "relegate", to: "demote" });
    expect(isError).toBe(false);
    expect(text).toContain("No function, method or class named `relegate`");
  });
});

describe("clarifydoc_rename_plan — route registrations", () => {
  const ROUTES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "league-api", version: "1.0.0", dependencies: { express: "4.18.0" } }),
    "src/handlers.ts": [
      "export function playFriendly(req: any, res: any) {",
      "  res.json([]);",
      "}",
      "export function playCup(req: any, res: any) {",
      "  res.json([]);",
      "}",
      "",
    ].join("\n"),
    "src/routes.ts": [
      "import express from 'express';",
      "import { playFriendly, playCup as cup } from './handlers';",
      "const router = express.Router();",
      "router.get('/friendly', playFriendly);",
      "router.get('/cup', cup);",
      "export default router;",
      "",
    ].join("\n"),
  };
  let routesDir = "";
  let routes: ReturnType<typeof buildMcpServer>["server"];
  const ask = async (args: Record<string, unknown>): Promise<string> => {
    const res = (await routes.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "clarifydoc_rename_plan", arguments: args } })) as { result: { content: Array<{ text: string }> } };
    return res.result.content[0]!.text;
  };

  beforeAll(async () => {
    routesDir = mkdtempSync(join(tmpdir(), "clarifydoc-rename-routes-"));
    for (const [name, text] of Object.entries(ROUTES)) {
      mkdirSync(dirname(join(routesDir, name)), { recursive: true });
      writeFileSync(join(routesDir, name), text);
    }
    routes = buildMcpServer({ projectRoot: routesDir, analysisDir: join(routesDir, "out"), allowAnalyze: true, analyzeSettings: { gitHistory: false }, log: () => {} }).server;
    await routes.handleMessage({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "clarifydoc_analyze", arguments: {} } });
  }, 120_000);
  afterAll(() => rmSync(routesDir, { recursive: true, force: true }));

  it("lists the route line that registers the handler in its own section, at the name", async () => {
    const text = await ask({ symbol: "playFriendly", to: "hostFriendly" });
    expect(text).toContain("Nothing is written");
    expect(text).toContain("## Route registrations (1)");
    const [, file, line, start, end] = text.match(/^- (src\/routes\.ts):(\d+):(\d+)-(\d+)$/m)!;
    expect(readFileSync(join(routesDir, file!), "utf-8").split("\n")[Number(line) - 1]!.slice(Number(start) - 1, Number(end) - 1)).toBe("playFriendly");
    expect(text).toContain("the definition, 0 call sites and 1 route registration");
  });

  it("finds the name inside a string, picks the one after `#`, and says when the line holds none", async () => {
    const rails = mkdtempSync(join(tmpdir(), "clarifydoc-rename-lines-"));
    try {
      mkdirSync(join(rails, "config"), { recursive: true });
      writeFileSync(join(rails, "config/routes.rb"), [
        "  get 'friendlies', to: 'clubs#friendly'",
        "  get 'friendly/friendly', to: 'clubs#friendly'",
        "  get 'friendly', post 'friendly'",
        "  resources :clubs",
        "  resources :clubs, only: [:friendly]",
        "",
      ].join("\n"));
      const sources = new Sources(rails);
      const at = async (line: number) => registrationSpan(sources, "config/routes.rb", line, "friendly");
      expect(await at(1)).toMatchObject({ span: { col: 32, end: 40 }, inString: true });
      expect(await at(2)).toMatchObject({ span: { col: 39, end: 47 } });
      expect((await at(3)).why).toMatch(/times on the route line|does not spell/);
      expect((await at(4)).why).toMatch(/does not spell `friendly`/);
      expect(await at(5)).toMatchObject({ span: { col: 29, end: 37 }, inString: false });
    } finally {
      rmSync(rails, { recursive: true, force: true });
    }
  });
});
