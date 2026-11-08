import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function scan(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-js-block-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), done: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetFile}:${l.targetSymbol}:${l.targetLine}`);

describe("a class a function declares", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "club.ts": "export class Club { rename(n: string) { return n; } }\n",
      "use.ts": `import { Club } from "./club";
export function build() {
  class Club { rename(n: string) { return n; } }
  const c = new Club();
  c.rename("x");
}
export function plain() {
  const c = new Club();
  c.rename("y");
}
`,
      "same.ts": `export class Table { sort() { return 1; } }
export function local() {
  class Table { sort() { return 2; } }
  const t = new Table();
  t.sort();
}
export function top() {
  const t = new Table();
  t.sort();
}
`,
    }));
  });
  afterAll(async () => done());

  it("constructs and calls the local class, never the imported namesake", () => {
    expect(targets(summary, "build", "Club")).toEqual(["use.ts:Club:3"]);
    expect(targets(summary, "build", "c.rename")).toEqual(["use.ts:Club.rename:3"]);
  });
  it("leaves the imported class to a function that declares none", () => {
    expect(targets(summary, "plain", "Club")).toEqual(["club.ts:Club:1"]);
    expect(targets(summary, "plain", "c.rename")).toEqual(["club.ts:Club.rename:1"]);
  });
  it("links the local class inside its function and the top-level namesake outside it", () => {
    expect(targets(summary, "local", "Table")).toEqual(["same.ts:Table:3"]);
    expect(targets(summary, "local", "t.sort")).toEqual(["same.ts:Table.sort:3"]);
    expect(targets(summary, "top", "Table")).toEqual(["same.ts:Table:1"]);
    expect(targets(summary, "top", "t.sort")).toEqual(["same.ts:Table.sort:1"]);
  });
});

describe("a block's own declarations", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "club.ts": `export class Club { rename(n: string) { return n; } }
export class Other { rename(n: string) { return n; } }
export function save() { return 1; }
`,
      "use.ts": `import { Club, Other, save } from "./club";
const cfg = { save: () => 1 };
function make(): Club { return new Club(); }
export function shadow(v: Other) {
  { let v = make(); v.rename("y"); }
  v.rename("z");
}
export function siblings() {
  { const save = cfg.save; save(); }
  { save(); }
}
export function own() { const save = cfg.save; save(); }
`,
    }));
  });
  afterAll(async () => done());

  it("a block local with no stated type hides the parameter of its name only inside the block", () => {
    const lines = summary.symbolLinks.filter((l) => l.sourceSymbol === "shadow" && l.callName === "v.rename");
    expect(lines.map((l) => `${l.sourceLine}:${l.targetSymbol}`)).toEqual(["6:Other.rename"]);
  });
  it("a name one block binds does not hide a module function called from a sibling block", () => {
    const calls = summary.symbolLinks.filter((l) => l.sourceSymbol === "siblings" && l.callName === "save");
    expect(calls.map((l) => `${l.sourceLine}:${l.targetFile}`)).toEqual(["10:club.ts"]);
    expect(targets(summary, "own", "save")).toEqual([]);
  });
});

describe("an intersection with an inline object type", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "club.ts": `export class Club { rename(n: string) { return n; } }
export class Named { rename(n: string) { return n; } }
`,
      "use.ts": `import { Club, Named } from "./club";
export function badge(x: Club & { badge: string }) { x.rename("a"); }
export function both(x: Club & Named) { x.rename("a"); }
export function bound<T extends Club>(x: T) { x.rename("a"); }
export function maybe(x: Club | undefined) { x?.rename("a"); }
`,
    }));
  });
  afterAll(async () => done());

  it("types the one named member", () => {
    expect(targets(summary, "badge", "x.rename")).toEqual(["club.ts:Club.rename:1"]);
    expect(targets(summary, "bound", "x.rename")).toEqual(["club.ts:Club.rename:1"]);
    expect(targets(summary, "maybe", "x?.rename")).toEqual(["club.ts:Club.rename:1"]);
  });
  it("never picks among two named members", () => {
    expect(targets(summary, "both", "x.rename")).toEqual([]);
  });
});

describe("an anonymous default export", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "package.json": JSON.stringify({ name: "x", dependencies: { next: "14.0.0", react: "18.0.0" } }),
      "lib/auth.ts": "export function withAuth(handler: any) { return handler; }\n",
      "lib/clubs.ts": "export function loadClubs() { return []; }\n",
      "pages/api/clubs.ts": `import { withAuth } from "../../lib/auth";
import { loadClubs } from "../../lib/clubs";
export default withAuth(async (req: any, res: any) => {
  res.json(await loadClubs());
});
`,
    }));
  });
  afterAll(async () => done());

  it("is the module's default function, so its calls and the route reach it", () => {
    expect(targets(summary, "default", "loadClubs")).toEqual(["lib/clubs.ts:loadClubs:1"]);
    const route = (summary.routeMap ?? []).find((r) => r.path === "/api/clubs");
    expect(route?.handler).toBe("default");
  });
});

describe("a Hono chain exported from one file and mounted in another", () => {
  let summary: ProjectAnalysis;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ summary, done } = await scan({
      "package.json": JSON.stringify({ name: "x", dependencies: { hono: "4.0.0" } }),
      "src/routes/clubs.ts": `import { Hono } from "hono";
export const clubs = new Hono()
  .get("/", (c) => c.json([]))
  .post("/:id/sign", (c) => c.json({}));
`,
      "src/index.ts": `import { Hono } from "hono";
import { clubs } from "./routes/clubs";
const app = new Hono();
app.route("/clubs", clubs);
export default app;
`,
    }));
  });
  afterAll(async () => done());

  it("keeps the mount prefix on every route", () => {
    expect((summary.routeMap ?? []).map((r) => r.path).sort()).toEqual(["/clubs", "/clubs/:id/sign"]);
  });
});
