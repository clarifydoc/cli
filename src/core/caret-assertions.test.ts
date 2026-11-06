import { describe, it, expect } from "vitest";
import { parseCaretAssertions, renderCarets, checkCaretAssertions, commentPrefixFor } from "./caret-assertions.js";
import { expectCarets, runCarets } from "./caret-testkit.js";

const lines = (...l: string[]) => l.join("\n") + "\n";

describe("caret grammar", () => {
  it("reads spans, arrows and the line they speak about, and leaves prose alone", () => {
    const src = lines("const a = f();", "//    ^ def a", "// ^ just a note", "x();", "// <- call");
    const parsed = parseCaretAssertions("a.ts", src, "//");
    expect(parsed.map((a) => [a.line, a.commentLine, a.startCol, a.endCol, a.marker, a.kind, a.text])).toEqual([
      [1, 2, 6, 7, "span", "def", "a"],
      [1, 3, 3, 4, "span", "just", "a note"],
      [4, 5, 0, 0, "arrow", "call", ""],
    ]);
  });

  it("takes the comment prefix from the language manifest", () => {
    expect(commentPrefixFor("typescript")).toBe("//");
    expect(commentPrefixFor("python")).toBe("#");
    expect(commentPrefixFor("sql")).toBe("--");
  });
});

describe("caret assertions, end to end", () => {
  const repo = lines(
    "function listClubs() {",
    "//       ^^^^^^^^^ def listClubs",
    "  return [];",
    "}",
    "function addClub(c) { return c; }",
    "module.exports = { listClubs, addClub };",
  );

  it("passes a JS call link and a definition", async () => {
    await expectCarets({
      "package.json": JSON.stringify({ name: "league" }),
      "repo.js": repo,
      "season.js": lines(
        "const repo = require('./repo');",
        "function openSeason() {",
        "  return repo.listClubs();",
        "  //          ^^^^^^^^^ call -> repo.js::listClubs",
        "}",
        "module.exports = { openSeason };",
      ),
    });
  });

  it("passes an Express route and the fetch that joins it", async () => {
    await expectCarets({
      "league/package.json": JSON.stringify({ name: "league", dependencies: { express: "4.18.0" } }),
      "league/app.js": lines(
        "const express = require('express');",
        "const app = express();",
        "app.get('/clubs', (req, res) => res.json([]));",
        "//       ^^^^^^ route GET /clubs",
      ),
      "web/package.json": JSON.stringify({ name: "web", dependencies: { react: "18.0.0" } }),
      "web/load.js": lines(
        "async function loadClubs() {",
        "  const r = await fetch('/clubs');",
        "  //                   ^^^^^^ api-call GET /clubs -> GET /clubs",
        "  return r.json();",
        "}",
      ),
    });
  });

  it("passes a table read and write on a Prisma client", async () => {
    await expectCarets({
      "package.json": JSON.stringify({ name: "league", dependencies: { "@prisma/client": "5.0.0" } }),
      "db/client.ts": "export const prisma: any = {};\n",
      "src/query.ts": lines(
        'import { prisma } from "../db/client";',
        "export async function listPlayers() {",
        "  return prisma.player.findMany();",
        "  //            ^^^^^^ table player read",
        "}",
        "export async function createGame(title: string) {",
        "  return prisma.game.create({ data: { title } });",
        "  //            ^^^^ table game write",
        "}",
      ),
    });
  });

  it("fails with what is found instead, and marks the unjudgeable as unmatched", async () => {
    const run = await runCarets({
      "package.json": JSON.stringify({ name: "league" }),
      "repo.js": lines(
        "function listClubs() {}",
        "//       ^^^^^^^^^ def addClub",
        "//       ^^^^^^^^^ wibble x",
        "module.exports = { listClubs };",
      ),
      "orphan.js": lines("// ^ def x", "function x() {}"),
    });
    const by = (file: string, kind: string) => run.results.find((r) => r.assertion.file === file && r.assertion.kind === kind)!;
    expect(by("repo.js", "def").status).toBe("failed");
    expect(by("repo.js", "def").found).toEqual(["def listClubs"]);
    expect(by("repo.js", "wibble").status).toBe("unmatched");
    expect(by("orphan.js", "def").status).toBe("unmatched");
  });

  it("renders a snapshot that checks clean when put back in the file", async () => {
    const files = { "package.json": JSON.stringify({ name: "league" }), "repo.js": repo.replace("//       ^^^^^^^^^ def listClubs\n", ""), "season.js": lines("const repo = require('./repo');", "function openSeason() {", "  return repo.listClubs();", "}") };
    const first = await runCarets(files);
    const snap = renderCarets(first.analysis, "season.js", first.files.get("season.js")!)!;
    expect(snap).toContain("call -> repo.js::listClubs");
    const again = await runCarets({ ...files, "season.js": snap });
    expect(again.results.length).toBeGreaterThan(0);
    expect(again.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(checkCaretAssertions(again.analysis, new Map())).toEqual([]);
  });
});
