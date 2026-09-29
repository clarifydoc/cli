import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javaKotlinRouteExtractor } from "./index.js";
import { extractJaxrsMicronautRoutes } from "./jaxrs.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * JAX-RS (Jersey/RESTEasy/Quarkus) splits a route across a class @Path, a
 * verb marker (@GET — argument-less), and an optional method @Path. Micronaut
 * uses @Controller("/x") + @Get("/y"). Neither produced any routes before.
 * The argument-less requirement on JAX-RS verbs keeps Retrofit client
 * interfaces (`@GET("users")` — outbound) from minting phantom inbound routes.
 */
async function routesOf(source: string, file: string): Promise<RouteInfo[]> {
  const lang = file.endsWith(".kt") ? "kotlin" : "java";
  const tree = await parseSource(source, lang as any, file);
  return javaKotlinRouteExtractor.extractRoutes(tree, source, file);
}

describe("JAX-RS resource routes", () => {
  it("composes class @Path + verb marker + method @Path (Java)", async () => {
    const SRC = `package x;
import javax.ws.rs.*;

@Path("/users")
public class UserResource {
  @GET
  public List<User> list() { return userService.findAll(); }

  @GET
  @Path("{id}")
  public User get(@PathParam("id") long id) { return userService.fetchUser(id); }

  @POST
  public Response create(User u) { return userService.save(u); }

  @DELETE
  @Path("{id}")
  public void remove(@PathParam("id") long id) { userService.delete(id); }
}`;
    const routes = await routesOf(SRC, "UserResource.java");
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "DELETE /users/{id}",
      "GET /users",
      "GET /users/{id}",
      "POST /users",
    ]);
    const get = routes.find((r) => r.httpMethod === "GET" && r.path === "/users/{id}")!;
    expect(get.handler).toBe("get");
    expect(get.calls.some((c) => /fetchUser/.test(c.name ?? ""))).toBe(true);
  });

  it("extracts Kotlin JAX-RS resources (Quarkus style)", async () => {
    const SRC = `package x

import jakarta.ws.rs.GET
import jakarta.ws.rs.Path

@Path("/fruits")
class FruitResource {
  @GET
  fun list(): List<Fruit> = repository.listAll()

  @GET
  @Path("/{id}")
  fun byId(id: Long): Fruit = repository.findById(id)
}`;
    const routes = await routesOf(SRC, "FruitResource.kt");
    const paths = routes.map((r) => r.path).sort();
    expect(paths).toEqual(["/fruits", "/fruits/{id}"]);
  });

  it("does NOT emit routes for Retrofit-style verb annotations with arguments", async () => {
    const SRC = `package x;
public interface UserApi {
  @GET("users/{id}")
  Call<User> getUser(@retrofit2.http.Path("id") String id);
}`;
    // No class @Path, and the verb carries an argument → outbound, not a route.
    const routes = await routesOf(SRC, "UserApi.java");
    expect(routes).toEqual([]);
  });

  it("skips MicroProfile @RegisterRestClient outbound interfaces", async () => {
    const SRC = `package x;
@RegisterRestClient
@Path("/remote")
public interface RemoteClient {
  @GET
  @Path("items")
  List<Item> items();
}`;
    expect(await routesOf(SRC, "RemoteClient.java")).toEqual([]);
  });
});

describe("Micronaut controller routes", () => {
  it("composes @Controller prefix with @Get/@Post paths (Kotlin)", async () => {
    const SRC = `package x

import io.micronaut.http.annotation.*

@Controller("/orders")
class OrderController(private val service: OrderService) {
  @Get
  fun all(): List<Order> = service.findAll()

  @Get("/{id}")
  fun byId(id: Long): Order = service.find(id)

  @Post("/")
  fun create(order: Order): Order = service.save(order)
}`;
    const routes = await routesOf(SRC, "OrderController.kt");
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "GET /orders",
      "GET /orders/{id}",
      "POST /orders",
    ]);
  });

  it("skips Micronaut @Client declarative HTTP clients (outbound)", async () => {
    const SRC = `package x;
@Client("/pets")
public interface PetClient {
  @Get("/{id}")
  Pet find(String id);
}`;
    expect(await routesOf(SRC, "PetClient.java")).toEqual([]);
  });
});

describe("JAX-RS client-proxy fence", () => {
  const CLIENT_SRC = `package x;
import jakarta.ws.rs.*;

@Path("/supplier/v1")
public interface SupplierApiJakarta {
  @GET
  @Path("/suppliers")
  Suppliers getSuppliers(@QueryParam("supplierIds") List<String> ids);
}`;

  it("does NOT read a JAX-RS interface under a client/ package as a served route", async () => {
    const routes = await routesOf(CLIENT_SRC, "src/main/java/com/x/client/supplier/SupplierApiJakarta.java");
    expect(routes).toEqual([]);
  });

  it("still extracts the same interface outside a client/ package", async () => {
    const routes = await routesOf(CLIENT_SRC, "src/main/java/com/x/api/supplier/SupplierApiJakarta.java");
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /supplier/v1/suppliers"]);
  });
});

describe("JAX-RS / Micronaut — guards and parameter bindings", () => {
  it("JAX-RS: @RolesAllowed on the class, @PathParam/@QueryParam/@Context, unannotated entity → body", async () => {
    const SRC = `package x;
@Path("/res")
@RolesAllowed("admin")
public class Res {
  @GET @Path("{id}") @PermitAll
  public String get(@PathParam("id") int id, @QueryParam("q") String q, Payload body, @Context UriInfo u) { return null; }
}`;
    const tree = await parseSource(SRC, "java" as any, "A.java");
    const routes: RouteInfo[] = [];
    extractJaxrsMicronautRoutes(tree.rootNode, routes);
    const [r] = routes;
    expect(r!.auth).toEqual({ policies: [], roles: ["admin"], schemes: [], anonymous: true, inherited: false });
    expect(r!.params).toEqual([
      { name: "id", type: "int", binding: "route" },
      { name: "q", type: "String", binding: "query" },
      { name: "body", type: "Payload", binding: "body", inferred: true },
      { name: "u", type: "UriInfo", binding: "services" },
    ]);
  });

  it("Micronaut: @Secured rule expressions become policies, @Body/@QueryValue bindings, complex default → body", async () => {
    const SRC = `package x
@Controller("/users")
@Secured("isAuthenticated()")
class UserController {
  @Post("/{id}")
  fun save(@PathVariable id: Long, @Body dto: CreateUserDto, @QueryValue q: String, extra: Extra): User = TODO()
}`;
    const tree = await parseSource(SRC, "kotlin" as any, "A.kt");
    const routes: RouteInfo[] = [];
    extractJaxrsMicronautRoutes(tree.rootNode, routes);
    const [r] = routes;
    expect(r!.auth).toMatchObject({ policies: ["isAuthenticated()"], roles: [], inherited: true });
    expect(r!.params).toEqual([
      { name: "id", type: "Long", binding: "route" },
      { name: "dto", type: "CreateUserDto", binding: "body" },
      { name: "q", type: "String", binding: "query" },
      { name: "extra", type: "Extra", binding: "body", inferred: true },
    ]);
  });
});
