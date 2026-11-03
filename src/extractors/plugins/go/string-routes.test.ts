import { beforeAll, describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { ensureLanguagesLoaded } from "../../registry.js";
import { blankCodeInStrings } from "./syntax.js";

beforeAll(async () => {
  await ensureLanguagesLoaded(["go"]);
});

const SRC = `package main

import "github.com/gin-gonic/gin"

const sample = \`r.GET("/fixtures/sample", handler)\`

const multi = \`
	r.POST("/fixtures/multi", handler)
\`

var quoted = "r.PUT(\\"/fixtures/quoted\\", handler)"
var spelled = "see router.DELETE(apiBase, handler) in the docs"

func listClubs(c *gin.Context) {}

func main() {
	r := gin.Default()
	r.GET("/clubs", listClubs)
	r.GET(\`/clubs/raw\`, listClubs)
	r.POST("/clubs", listClubs) // r.PATCH("/clubs/commented", listClubs)
	r.Run()
}
`;

describe("Go route registrations spelled inside string literals", () => {
  it("are not routes; registrations in code are, raw-string paths included", () => {
    const routes = extractWithRegex(SRC, "main.go", "go").routes;
    expect(routes.map((r) => `${r.httpMethod} ${r.path} :${r.line}`)).toEqual([
      "GET /clubs :18",
      "GET /clubs/raw :19",
      "POST /clubs :20",
    ]);
  });

  it("blanks a literal that quotes a string or writes a selector call, and keeps paths, runes and lengths", () => {
    const lines = [
      'const sample = `r.GET("/x", h)`',
      'r.GET("/clubs", h) // keep',
      'var q = "a.Do(\\"b\\")"; var c = \'"\'; var p = "/clubs/{id}"',
      'var s = "call club.Kick(x) now"',
    ];
    const out = blankCodeInStrings(lines);
    expect(out.map((l) => l.length)).toEqual(lines.map((l) => l.length));
    expect(out).toEqual([
      "const sample = `" + " ".repeat(14) + "`",
      'r.GET("/clubs", h) // keep',
      'var q = "' + " ".repeat('a.Do(\\"b\\")'.length) + '"; var c = \'"\'; var p = "/clubs/{id}"',
      'var s = "' + " ".repeat("call club.Kick(x) now".length) + '"',
    ]);
  });
});
