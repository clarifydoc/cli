import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { phpRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

/**
 * Symfony's #[Route] attributes were only understood by the dormant PHP regex
 * spec — PHP parses via tree-sitter, so Symfony apps produced zero routes.
 */
async function routesOf(source: string, filePath = "src/Controller/UserController.php"): Promise<RouteInfo[]> {
  const tree = await parseSource(source, "php" as any, filePath);
  return phpRouteExtractor.extractRoutes(tree, source, filePath);
}

describe("Symfony #[Route] attributes", () => {
  it("composes class prefix + method paths, one route per methods: verb", async () => {
    const SRC = `<?php

namespace App\\Controller;

use Symfony\\Component\\Routing\\Attribute\\Route;

#[Route('/api/users', name: 'users_')]
class UserController extends AbstractController
{
    #[Route('', name: 'list', methods: ['GET'])]
    public function list(): JsonResponse
    {
        return $this->json($this->repo->findAll());
    }

    #[Route('/{id}', name: 'show', methods: ['GET', 'HEAD'])]
    public function show(int $id): JsonResponse
    {
        return $this->json($this->repo->loadUser($id));
    }

    #[Route('/{id}', methods: ['DELETE'])]
    public function remove(int $id): Response
    {
        $this->repo->removeUser($id);
        return new Response(null, 204);
    }
}`;
    const routes = await routesOf(SRC);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`).sort()).toEqual([
      "DELETE /api/users/{id} -> remove",
      "GET /api/users -> list",
      "GET /api/users/{id} -> show",
      "HEAD /api/users/{id} -> show",
    ]);
    const show = routes.find((r) => r.handler === "show")!;
    expect(show.calls.some((c) => /loadUser/.test(c.name ?? ""))).toBe(true);
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
