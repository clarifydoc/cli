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

public interface UserApi {
  @GET("users/{id}")
  Call<User> getUser(@Path("id") String id);

  @POST("users/new")
  Call<User> createUser(@Body User user);
}`;
    const calls = apiCalls(await sourcesOf(SRC, "java", "UserApi.java"));
    expect(calls.map((c) => `${c.name} ${c.target}`).sort()).toEqual([
      "GET /users/{id}",
      "POST /users/new",
    ]);
  });

  it("emits api-calls for Kotlin Retrofit interfaces", async () => {
    const SRC = `package x

import retrofit2.http.GET
import retrofit2.http.Path

interface OrderApi {
  @GET("api/orders/{id}")
  suspend fun order(@Path("id") id: Long): Order
}`;
    const calls = apiCalls(await sourcesOf(SRC, "kotlin", "OrderApi.kt"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("GET");
    expect(calls[0]!.target).toBe("/api/orders/{id}");
  });

  it("does NOT emit api-calls for JAX-RS marker verbs (no argument)", async () => {
    const SRC = `package x;
import javax.ws.rs.*;

@Path("/users")
public class UserResource {
  @GET
  public List<User> list() { return repo.loadAll(); }
}`;
    expect(apiCalls(await sourcesOf(SRC, "java", "UserResource.java"))).toEqual([]);
  });
});

describe("Feign client interfaces", () => {
  it("treats Spring mapping annotations as outbound calls, with @FeignClient path prefix", async () => {
    const SRC = `package x;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "inventory", path = "/api/inventory")
public interface InventoryClient {
  @GetMapping("/items/{id}")
  Item item(@PathVariable("id") long id);

  @PostMapping(value = "/items")
  Item create(@RequestBody Item item);
}`;
    const calls = apiCalls(await sourcesOf(SRC, "java", "InventoryClient.java"));
    expect(calls.map((c) => `${c.name} ${c.target}`).sort()).toEqual([
      "GET /api/inventory/items/{id}",
      "POST /api/inventory/items",
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
