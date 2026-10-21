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
 * interfaces (`@GET("players")` — outbound) from minting phantom inbound routes.
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

@Path("/players")
public class PlayerResource {
  @GET
  public List<Player> list() { return playerService.findAll(); }

  @GET
  @Path("{id}")
  public Player get(@PathParam("id") long id) { return playerService.fetchPlayer(id); }

  @POST
  public Response create(Player u) { return playerService.save(u); }

  @DELETE
  @Path("{id}")
  public void remove(@PathParam("id") long id) { playerService.delete(id); }
}`;
    const routes = await routesOf(SRC, "PlayerResource.java");
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "DELETE /players/{id}",
      "GET /players",
      "GET /players/{id}",
      "POST /players",
    ]);
    const get = routes.find((r) => r.httpMethod === "GET" && r.path === "/players/{id}")!;
    expect(get.handler).toBe("get");
    expect(get.calls.some((c) => /fetchPlayer/.test(c.name ?? ""))).toBe(true);
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
public interface PlayerApi {
  @GET("players/{id}")
  Call<Player> getPlayer(@retrofit2.http.Path("id") String id);
}`;
    // No class @Path, and the verb carries an argument → outbound, not a route.
    const routes = await routesOf(SRC, "PlayerApi.java");
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

@Controller("/cars")
class CarController(private val service: CarService) {
  @Get
  fun all(): List<Car> = service.findAll()

  @Get("/{id}")
  fun byId(id: Long): Car = service.find(id)

  @Post("/")
  fun create(car: Car): Car = service.save(car)
}`;
    const routes = await routesOf(SRC, "CarController.kt");
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`).sort()).toEqual([
      "GET /cars",
      "GET /cars/{id}",
      "POST /cars",
    ]);
  });

  it("skips Micronaut @Client declarative HTTP clients (outbound)", async () => {
    const SRC = `package x;
@Client("/vehicles")
public interface VehicleClient {
  @Get("/{id}")
  Vehicle find(String id);
}`;
    expect(await routesOf(SRC, "VehicleClient.java")).toEqual([]);
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
@Controller("/players")
@Secured("isAuthenticated()")
class PlayerController {
  @Post("/{id}")
  fun save(@PathVariable id: Long, @Body dto: CreatePlayerDto, @QueryValue q: String, extra: Extra): Player = TODO()
}`;
    const tree = await parseSource(SRC, "kotlin" as any, "A.kt");
    const routes: RouteInfo[] = [];
    extractJaxrsMicronautRoutes(tree.rootNode, routes);
    const [r] = routes;
    expect(r!.auth).toMatchObject({ policies: ["isAuthenticated()"], roles: [], inherited: true });
    expect(r!.params).toEqual([
      { name: "id", type: "Long", binding: "route" },
      { name: "dto", type: "CreatePlayerDto", binding: "body" },
      { name: "q", type: "String", binding: "query" },
      { name: "extra", type: "Extra", binding: "body", inferred: true },
    ]);
  });
});

describe("JAX-RS routes name the operation they are", () => {
  it("records the declaring interface, fully qualified, and the method", async () => {
    const SRC = `package com.acme.person.api;
import javax.ws.rs.*;

@Path("/v1/")
public interface PersonRepository {
  @GET
  @Path("persons/{personId}")
  Person getPerson(@PathParam("personId") String personId);
}`;
    const routes = await routesOf(SRC, "PersonRepository.java");
    expect(routes.map((r) => [r.httpMethod, r.path, r.contract])).toEqual([
      ["GET", "/v1/persons/{personId}", { type: "com.acme.person.api.PersonRepository", method: "getPerson" }],
    ]);
  });
});
