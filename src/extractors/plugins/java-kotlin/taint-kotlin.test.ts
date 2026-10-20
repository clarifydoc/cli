import { describe, it, expect } from "vitest";
import "../../registry.js";
import { parseSource } from "../../../parsers/parser-manager.js";
import { kotlinTaint } from "./taint.js";

async function kt(src: string) {
  return kotlinTaint(await parseSource(src, "kotlin" as never, "Api.kt"), src, "Api.kt").map((i) => [i.category, i.line]);
}

describe("handler taint — Kotlin", () => {
  it("follows Spring request parameters through interpolation, past a guard and a conversion, into a helper", async () => {
    expect(await kt(`
@RestController
class Search(private val jdbcTemplate: JdbcTemplate) {
    @GetMapping("/search")
    fun search(@RequestParam q: String, @RequestParam page: String, model: Model): List<Map<String, Any>> {
        val sql = "SELECT * FROM items WHERE name = '\${q}'"
        jdbcTemplate.queryForList(sql)
        jdbcTemplate.queryForList("SELECT * FROM items LIMIT \${page.toInt()}")
        export(q)
        if (isValid(q)) {
            jdbcTemplate.queryForList("SELECT 1 WHERE x = '$q'")
        }
        return emptyList()
    }

    @PostMapping("/files")
    fun upload(@RequestParam name: String, id: Long) {
        File("/data/" + name).readText()
    }

    private fun export(label: String) {
        Runtime.getRuntime().exec("tar czf " + label)
    }
}`)).toEqual([["sql-injection", 7], ["command-injection", 22], ["path-traversal", 18]]);
  });

  it("reads Ktor request input off call", async () => {
    expect(await kt(`
fun Application.module() {
    routing {
        get("/proxy") {
            val target = call.parameters["url"]
            val body = URL(target).readText()
            call.respondText(body)
        }
    }
}`)).toEqual([["ssrf", 6]]);
  });
});
