import { describe, it, expect } from "vitest";
import "../../../registry.js";
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javaKotlinRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

async function routesOf(source: string, lang: "java" | "kotlin" = "java"): Promise<RouteInfo[]> {
  const file = lang === "java" ? "Books.java" : "Shows.kt";
  const tree = await parseSource(source, lang as any, file);
  return javaKotlinRouteExtractor.extractRoutes(tree, source, file);
}
const rows = (rs: RouteInfo[]) => rs.map((r) => `${r.httpMethod} ${r.path} → ${r.handler}${r.params?.length ? ` (${r.params.map((p) => `${p.name}: ${p.type}`).join(", ")})` : ""}`);

describe("JVM GraphQL controllers", () => {
  it("reads Spring for GraphQL mappings: names, schema mappings on root types, arguments, guards", async () => {
    const routes = await routesOf(`
import org.springframework.graphql.data.method.annotation.*;
@Controller
public class BookController {
  @QueryMapping
  public Book bookById(@Argument String id) { return repo.load(id); }
  @MutationMapping(name = "addBook")
  @PreAuthorize("hasRole('ADMIN')")
  public Book add(@Argument("input") BookInput input) { return repo.save(input); }
  @SchemaMapping(typeName = "Query", field = "authors")
  public List<Author> authors() { return List.of(); }
  @SchemaMapping(typeName = "Book", field = "author")
  public Author author(Book book) { return null; }
  @GetMapping("/health") public String health() { return "ok"; }
}`);
    expect(rows(routes)).toEqual([
      "GET /health → health",
      "POST /graphql/bookById → BookController.bookById (id: String)",
      "POST /graphql/addBook → BookController.add (input: BookInput)",
      "POST /graphql/authors → BookController.authors",
    ]);
    expect(routes[2]!.middleware).toEqual([`PreAuthorize("hasRole('ADMIN')")`]);
    expect(routes[1]!.calls.map((c) => c.name)).toContain("repo.load");
  });

  it("reads Netflix DGS data fetchers in Kotlin", async () => {
    const routes = await routesOf(`
import com.netflix.graphql.dgs.*
@DgsComponent
class ShowsDataFetcher {
    @DgsQuery
    fun shows(@InputArgument titleFilter: String?): List<Show> = repo.all(titleFilter)
    @DgsData(parentType = "Mutation", field = "addShow")
    fun add(@InputArgument input: ShowInput): Show = repo.add(input)
    @DgsData(parentType = "Show", field = "reviews")
    fun reviews(): List<Review> = emptyList()
}`, "kotlin");
    expect(rows(routes)).toEqual(["POST /graphql/shows → ShowsDataFetcher.shows (titleFilter: String?)", "POST /graphql/addShow → ShowsDataFetcher.add (input: ShowInput)"]);
  });
});
