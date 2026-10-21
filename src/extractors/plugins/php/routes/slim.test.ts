import { describe, it, expect } from "vitest";
import { parseSource } from "../../../../parsers/parser-manager.js";
import { phpRouteExtractor } from "./index.js";

const routesOf = async (src: string) => {
  const tree = await parseSource(src, "php" as any, "routes.php");
  return phpRouteExtractor.extractRoutes(tree, src, "app/routes.php");
};

describe("Slim routes", () => {
  it("reads registrations on the app and its groups, wherever they sit", async () => {
    const routes = await routesOf(`<?php
use Slim\\App;
use Slim\\Routing\\RouteCollectorProxy;

return function (App $app) {
    $app->post('/getquote', function (Request $request, Response $response) {
        $quote = calculateQuote($request->getParsedBody());
        return $response;
    });
    $app->get('/matches/{id}', MatchAction::class);
    $app->map(['GET', 'POST'], '/table', 'TableController:show');
    $app->group('/api', function (RouteCollectorProxy $group) {
        $group->get('/clubs', [ClubController::class, 'list']);
        $group->group('/v2', function (RouteCollectorProxy $v2) {
            $v2->delete('/clubs/{id}', [ClubController::class, 'remove']);
        });
    });
};`);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "POST /getquote null",
      "GET /matches/{id} MatchAction.__invoke",
      "GET /table TableController.show",
      "POST /table TableController.show",
      "GET /api/clubs ClubController.list",
      "DELETE /api/v2/clubs/{id} ClubController.remove",
    ]);
    expect(routes[0]!.calls.map((c) => c.name)).toContain("calculateQuote");
  });
});
