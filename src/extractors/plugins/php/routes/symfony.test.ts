import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { phpRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Symfony's #[Route] attributes were only understood by the dormant PHP regex
 * spec — PHP parses via tree-sitter, so Symfony apps produced zero routes.
 */
async function routesOf(source: string, filePath = "src/Controller/PlayerController.php"): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "php" as any, filePath);
  return phpRouteExtractor.extractRoutes(tree, source, filePath);
}

describe("Symfony #[Route] attributes", () => {
  it("composes class prefix + method paths, one route per methods: verb", async () => {
    const SRC = `<?php

namespace App\\Controller;

use Symfony\\Component\\Routing\\Attribute\\Route;

#[Route('/api/players', name: 'players_')]
class PlayerController extends AbstractController
{
    #[Route('', name: 'list', methods: ['GET'])]
    public function list(): JsonResponse
    {
        return $this->json($this->repo->findAll());
    }

    #[Route('/{id}', name: 'show', methods: ['GET', 'HEAD'])]
    public function show(int $id): JsonResponse
    {
        return $this->json($this->repo->loadPlayer($id));
    }

    #[Route('/{id}', methods: ['DELETE'])]
    public function remove(int $id): Response
    {
        $this->repo->removePlayer($id);
        return new Response(null, 204);
    }
}`;
    const routes = await routesOf(SRC);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`).sort()).toEqual([
      "DELETE /api/players/{id} -> remove",
      "GET /api/players -> list",
      "GET /api/players/{id} -> show",
      "HEAD /api/players/{id} -> show",
    ]);
    const show = routes.find((r) => r.handler === "show")!;
    expect(show.calls.some((c) => /loadPlayer/.test(c.name ?? ""))).toBe(true);
  });

  it("treats a methods:-less #[Route] as a verb wildcard and honors verb attributes", async () => {
    const SRC = `<?php
use Symfony\\Component\\Routing\\Attribute\\Route;

class MiscController
{
    #[Route('/anything')]
    public function anything(): Response { return new Response(); }

    #[Get('/items')]
    public function items(): Response { return new Response(); }
}`;
    const routes = await routesOf(SRC);
    expect(routes.find((r) => r.path === "/anything")!.httpMethod).toBeNull();
    const items = routes.find((r) => r.path === "/items")!;
    expect(items.httpMethod).toBe("GET");
    expect(items.handler).toBe("items");
  });

  it("produces nothing for attribute-free PHP", async () => {
    const SRC = `<?php
class Plain { public function run(): void {} }`;
    expect(await routesOf(SRC, "src/Plain.php")).toEqual([]);
  });
});

/**
 * The attribute layer: `#[IsGranted]` / `#[Security]` guards (class-level
 * inherited, method-level own) and parameter bindings from Symfony's
 * mapping attributes, injected types and the path.
 */
describe("Symfony guards and parameter bindings", () => {
  it("inherits class-level IsGranted, adds the method's own, and binds params", async () => {
    const SRC = `<?php
namespace App\\Controller;

#[Route('/api/players')]
#[IsGranted('ROLE_ADMIN')]
class PlayerController extends AbstractController
{
    #[Route('/{id}', methods: ['POST'])]
    #[IsGranted('ROLE_EDITOR')]
    public function update(
        int $id,
        #[MapRequestPayload] CreatePlayerDto $dto,
        #[MapQueryParameter] ?string $q,
        #[MapQueryParameter(name: 'page_size')] int $pageSize = 20,
        Request $request,
        #[CurrentUser] ?Player $me = null,
        PlayerRepository $repo,
    ): JsonResponse {
        $trace = $request->headers->get('X-Trace');
        return $this->json([]);
    }

    #[Route('/{id}', methods: ['GET'])]
    #[IsGranted('view', 'player')]
    public function show(Player $player, LoggerInterface $logger): JsonResponse { return $this->json($player); }

    #[Route('', methods: ['GET'])]
    #[Security("is_granted('ROLE_ADMIN') or is_granted('ROLE_AUDITOR')")]
    public function list(#[MapQueryString] ListFilter $filter): JsonResponse { return $this->json([]); }

    #[Route('/expr', methods: ['GET'])]
    #[IsGranted(new Expression('user.isActive()'))]
    public function expr(): JsonResponse { return $this->json([]); }
}`;
    const routes = await routesOf(SRC);
    const byHandler = (h: string) => routes.find((r) => r.handler === h)!;

    const update = byHandler("update");
    expect(update.middleware).toEqual(["IsGranted('ROLE_ADMIN')", "IsGranted('ROLE_EDITOR')"]);
    expect(update.auth).toEqual({ roles: ["ROLE_ADMIN", "ROLE_EDITOR"], policies: [], schemes: [], anonymous: false, inherited: false });
    expect(update.params).toEqual([
      { name: "id", type: "int", binding: "route", inferred: true },
      { name: "dto", type: "CreatePlayerDto", binding: "body" },
      { name: "q", type: "string", binding: "query" },
      { name: "page_size", type: "int", binding: "query" },
      { name: "request", type: "Request", binding: "services", inferred: true },
      { name: "me", type: "Player", binding: "services" },
      { name: "repo", type: "PlayerRepository", binding: "services", inferred: true },
      { name: "X-Trace", type: null, binding: "header", inferred: true },
    ]);

    // A voter attribute with a subject is a policy; an entity on a route with a
    // path parameter is loaded by the entity value resolver (route, inferred).
    const show = byHandler("show");
    expect(show.auth).toMatchObject({ roles: ["ROLE_ADMIN"], policies: ["view,player"], inherited: false });
    expect(show.params).toEqual([
      { name: "player", type: "Player", binding: "route", inferred: true },
      { name: "logger", type: "LoggerInterface", binding: "services", inferred: true },
    ]);

    // `#[Security("…")]` and an Expression subject carry the expression as the policy.
    expect(byHandler("list").auth!.policies).toEqual(["is_granted('ROLE_ADMIN') or is_granted('ROLE_AUDITOR')"]);
    expect(byHandler("list").params).toEqual([{ name: "filter", type: "ListFilter", binding: "query" }]);
    expect(byHandler("expr").auth!.policies).toEqual(["user.isActive()"]);
    expect(byHandler("expr").auth!.roles).toEqual(["ROLE_ADMIN"]);
    expect(byHandler("expr").params).toBeUndefined();
  });

  it("declares nothing when no guard is present, and no route binding without a path token", async () => {
    const SRC = `<?php
class PingController {
    #[Route('/ping', methods: ['GET'])]
    public function ping(): Response { return new Response('pong'); }
    #[Route('/echo', methods: ['POST'])]
    public function echo(Payload $payload): Response { return new Response('pong'); }
}`;
    const [route, echo] = await routesOf(SRC);
    expect(route!.auth).toBeUndefined();
    expect(route!.middleware).toEqual([]);
    expect(route!.params).toBeUndefined();
    // A class-typed argument with nothing in the path to load it by: unknown, not guessed.
    expect(echo!.params).toEqual([{ name: "payload", type: "Payload", binding: null }]);
  });
});
