import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";

/**
 * Retrofit and Feign declare OUTBOUND HTTP calls as annotated interface
 * methods — no imperative client call exists to pattern-match, so before this
 * the whole client interface was invisible and service→service traces
 * dead-ended. The emitted api-call carries verb + app-relative path, which is
 * exactly what linkApiCallsToRoutes joins to the serving backend route.
 */
async function sourcesOf(src: string, lang: Language, file: string): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, lang as any, file);
  return new JavaKotlinDataSourceExtractor().extract(tree, src);
}

const apiCalls = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "api-call");

describe("Retrofit client interfaces", () => {
  it("emits one api-call per verb annotation with the path as target (Java)", async () => {
    const SRC = `package x;
import retrofit2.http.*;

public interface PlayerApi {
  @GET("players/{id}")
  Call<Player> getPlayer(@Path("id") String id);

  @POST("players/new")
  Call<Player> createPlayer(@Body Player player);
}`;
    const calls = apiCalls(await sourcesOf(SRC, "java", "PlayerApi.java"));
    expect(calls.map((c) => `${c.name} ${c.target}`).sort()).toEqual([
      "GET /players/{id}",
      "POST /players/new",
    ]);
  });

  it("emits api-calls for Kotlin Retrofit interfaces", async () => {
    const SRC = `package x

import retrofit2.http.GET
import retrofit2.http.Path

interface CarApi {
  @GET("api/cars/{id}")
  suspend fun car(@Path("id") id: Long): Car
}`;
    const calls = apiCalls(await sourcesOf(SRC, "kotlin", "CarApi.kt"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("GET");
    expect(calls[0]!.target).toBe("/api/cars/{id}");
  });

  it("does NOT emit api-calls for JAX-RS marker verbs (no argument)", async () => {
    const SRC = `package x;
import javax.ws.rs.*;

@Path("/players")
public class PlayerResource {
  @GET
  public List<Player> list() { return repo.loadAll(); }
}`;
    expect(apiCalls(await sourcesOf(SRC, "java", "PlayerResource.java"))).toEqual([]);
  });
});

describe("Feign client interfaces", () => {
  it("treats Spring mapping annotations as outbound calls, with @FeignClient path prefix", async () => {
    const SRC = `package x;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "fleet", path = "/api/fleet")
public interface FleetClient {
  @GetMapping("/items/{id}")
  Item item(@PathVariable("id") long id);

  @PostMapping(value = "/items")
  Item create(@RequestBody Item item);
}`;
    const calls = apiCalls(await sourcesOf(SRC, "java", "FleetClient.java"));
    expect(calls.map((c) => `${c.name} ${c.target}`).sort()).toEqual([
      "GET /api/fleet/items/{id}",
      "POST /api/fleet/items",
    ]);
  });

  it("ignores mapping annotations in non-Feign files (those are inbound routes)", async () => {
    const SRC = `package x;
import org.springframework.web.bind.annotation.*;

@RestController
public class ItemController {
  @GetMapping("/items/{id}")
  public Item item(@PathVariable long id) { return service.loadItem(id); }
}`;
    expect(apiCalls(await sourcesOf(SRC, "java", "ItemController.java"))).toEqual([]);
  });
});
