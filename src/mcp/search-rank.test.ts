import { describe, expect, it } from "vitest";
import { normalize, parseQuery, rankCandidates, scoreCandidate, splitTokens, type Candidate } from "./search-rank.js";

const candidate = (over: Partial<Candidate> & Pick<Candidate, "name">): Candidate => ({
  kind: "file",
  path: null,
  line: null,
  weight: 0,
  text: over.name,
  ...over,
});

const scoreOf = (c: Candidate, query: string) => scoreCandidate(c, parseQuery(query)).score;
const viaOf = (c: Candidate, query: string) => scoreCandidate(c, parseQuery(query)).via;

describe("splitTokens", () => {
  it("splits camelCase and PascalCase", () => {
    expect(splitTokens("getUserById")).toEqual(["get", "user", "by", "id"]);
    expect(splitTokens("ArticlesRepository")).toEqual(["articles", "repository"]);
  });

  it("splits runs of capitals at the last one", () => {
    expect(splitTokens("HTTPServerError")).toEqual(["http", "server", "error"]);
  });

  it("splits every separator a path or a route uses", () => {
    expect(splitTokens("article.service.ts")).toEqual(["article", "service", "ts"]);
    expect(splitTokens("/profiles/:username")).toEqual(["profiles", "username"]);
    expect(splitTokens("user_id")).toEqual(["user", "id"]);
    expect(splitTokens("prisma-client")).toEqual(["prisma", "client"]);
  });

  it("is empty for nothing, and for punctuation with no word in it", () => {
    expect(splitTokens("")).toEqual([]);
    expect(splitTokens(null)).toEqual([]);
    expect(splitTokens("/")).toEqual([]);
  });

  it("normalizes two spellings of one name to the same string", () => {
    expect(normalize("getUserById")).toBe(normalize("get_user_by_id"));
    expect(normalize("/tags")).toBe(normalize("tags"));
  });
});

describe("scoreCandidate tiers", () => {
  it("100 — the name is the query, however either is spelled", () => {
    expect(scoreOf(candidate({ name: "getUserById" }), "get user by id")).toBe(100);
    expect(scoreOf(candidate({ name: "/tags" }), "tags")).toBe(100);
  });

  it("100 via aka — a route handler, or a column, counts as a name", () => {
    const route = candidate({ kind: "route", name: "/users/login", nameIsPath: true, aka: ["login"] });
    expect(scoreOf(route, "login")).toBe(100);
    expect(viaOf(route, "login")).toBe("aka");
  });

  it("100 via aka — a multi-segment endpoint is named by its last segment", () => {
    const route = candidate({ kind: "route", name: "/articles/:slug/favorite", nameIsPath: true });
    expect(scoreCandidate(route, parseQuery("favorite"))).toEqual({ score: 100, via: "aka" });
    // A single-segment path is its own name, and stays a name match — otherwise
    // the router line for `/settings` would outrank the screen called Settings.
    const single = candidate({ kind: "route", name: "/settings", nameIsPath: true });
    expect(scoreCandidate(single, parseQuery("settings"))).toEqual({ score: 100, via: "name" });
  });

  it("90 — the query names the file, only the last extension dropped", () => {
    const file = (path: string) => candidate({ name: path.slice(path.lastIndexOf("/") + 1), path });
    expect(scoreOf(file("backend/src/prisma/prisma-client.ts"), "prisma client")).toBe(90);
    expect(scoreOf(file("backend/routes/article/article.service.ts"), "article.service")).toBe(90);
  });

  it("40 — naming a DIRECTORY is much weaker than naming the file", () => {
    const client = candidate({ name: "prisma-client.ts", path: "backend/src/prisma/prisma-client.ts" });
    const entity = candidate({ kind: "entity", name: "Article", path: "backend/src/prisma/schema.prisma" });
    // Both sit under `prisma/`; only one is called prisma-something.
    expect(scoreOf(client, "prisma")).toBe(70);
    expect(scoreOf(entity, "prisma")).toBe(40);
  });

  it("70 vs 50 — every term is in the name, from the start or not", () => {
    expect(scoreOf(candidate({ name: "getUserById" }), "get user")).toBe(70);
    expect(scoreOf(candidate({ name: "getUserById" }), "user id")).toBe(50);
  });

  it("30 — every term is in the name plus the path", () => {
    const c = candidate({ name: "create", path: "backend/src/app/routes/article/article.service.ts" });
    expect(scoreOf(c, "article create")).toBe(30);
  });

  it("10 — a partial word the tokenizer cannot see", () => {
    expect(scoreOf(candidate({ name: "Authentication" }), "authent")).toBe(10);
  });

  it("10 — a query that is all punctuation falls back to raw substring", () => {
    expect(scoreOf(candidate({ kind: "route", name: "/", nameIsPath: true }), "/")).toBe(10);
  });

  it("0 — a term that is nowhere", () => {
    expect(scoreOf(candidate({ name: "getUserById" }), "user password")).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("a name query prefers the thing called Settings over the router line mentioning /settings", () => {
    const rows = rankCandidates(
      [
        candidate({
          kind: "route",
          name: "/settings",
          nameIsPath: true,
          path: "frontend/src/App.js",
          line: 41,
          text: "route row",
        }),
        candidate({
          kind: "screen",
          name: "Settings",
          path: "frontend/src/components/Settings.js",
          line: 8,
          text: "screen row",
        }),
      ],
      "Settings",
    );
    expect(rows.map((r) => r.text)).toEqual(["screen row", "route row"]);
  });

  it("a path-shaped query inverts that — the route wins over the file sharing its name", () => {
    const rows = rankCandidates(
      [
        candidate({ kind: "file", name: "app/api/routes/tags.py", path: "app/api/routes/tags.py", text: "file row" }),
        candidate({
          kind: "route",
          name: "/tags",
          nameIsPath: true,
          path: "app/api/routes/tags.py",
          line: 10,
          text: "route row",
        }),
      ],
      "/tags",
    );
    expect(rows[0]?.text).toBe("route row");
  });

  it("an API route matching on its own name leads — an endpoint is the entry point", () => {
    const rows = rankCandidates(
      [
        candidate({ kind: "screen", name: "login", path: "frontend/Login.js", line: 4, text: "screen row" }),
        candidate({
          kind: "route",
          name: "/users/login",
          nameIsPath: true,
          isEndpoint: true,
          aka: ["login"],
          path: "backend/auth.controller.ts",
          line: 30,
          text: "route row",
        }),
      ],
      "login",
    );
    expect(rows[0]?.text).toBe("route row");
  });

  it("but a FRONTEND route does not — its handler is the component it renders", () => {
    const rows = rankCandidates(
      [
        candidate({
          kind: "route",
          name: "/editor",
          nameIsPath: true,
          aka: ["Editor"],
          path: "frontend/src/components/App.js",
          line: 62,
          text: "route row",
        }),
        candidate({
          kind: "screen",
          name: "Editor",
          path: "frontend/src/components/Editor.js",
          line: 20,
          text: "screen row",
        }),
      ],
      "Editor",
    );
    expect(rows[0]?.text).toBe("screen row");
  });

  it("a row that can be opened at a line beats one that can only be opened", () => {
    const rows = rankCandidates(
      [
        candidate({ kind: "file", name: "src/Comment.js", path: "src/Comment.js", text: "no line" }),
        candidate({ kind: "symbol", name: "src/Comment.js", path: "src/Comment.js", line: 3, text: "with line" }),
      ],
      "src/Comment.js",
    );
    expect(rows[0]?.text).toBe("with line");
  });

  it("breaks a remaining tie on the usefulness prior, then ordinally", () => {
    const rows = rankCandidates(
      [
        candidate({ name: "Article", path: "a.ts", weight: 1, text: "zzz low impact" }),
        candidate({ name: "Article", path: "b.ts", weight: 9, text: "aaa high impact" }),
        candidate({ name: "Article", path: "c.ts", weight: 1, text: "aab low impact" }),
      ],
      "Article",
    );
    expect(rows.map((r) => r.text)).toEqual(["aaa high impact", "aab low impact", "zzz low impact"]);
  });

  it("drops non-matches and keeps the score it assigned", () => {
    const rows = rankCandidates([candidate({ name: "login" }), candidate({ name: "logout" })], "login");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBe(100);
  });
});

describe("the loose pass", () => {
  const rows = [
    candidate({ kind: "symbol", name: "login", path: "backend/auth.ts", line: 30, text: "login symbol" }),
    candidate({ kind: "screen", name: "NotFoundPage", path: "pages/NotFoundPage.tsx", line: 9, text: "not found" }),
  ];

  it("finds the one term that names something, inside a sentence", () => {
    const ranked = rankCandidates(rows, "where is the login endpoint", { loose: true });
    expect(ranked.map((r) => r.text)).toEqual(["login symbol"]);
  });

  it("does not let a stray word drag in everything it appears inside", () => {
    // "not" is a token of NotFoundPage, but it does not NAME it — a loose match
    // has to be a whole name or a whole path segment, or it is noise.
    expect(rankCandidates(rows, "zzz-not-a-thing-zzz", { loose: true })).toEqual([]);
  });

  it("scores by how many terms named something", () => {
    const ranked = rankCandidates(rows, "login auth", { loose: true });
    expect(ranked[0]?.score).toBe(101); // name exact + one more term hitting the path segment
  });
});
