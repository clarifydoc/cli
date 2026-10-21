import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { extractNestjsRoutes } from "./nestjs.js";
import { extractExpressRoutes, applyRouterLevelGuards } from "./express.js";
import { extractAspnetRoutes } from "../../csharp/routes/aspnet.js";
import type { RouteInfo } from "../../../../types/analysis.js";

const show = (routes: RouteInfo[]) => routes.map((r) => `${r.httpMethod} ${r.path}: ${(r.filters ?? []).map((f) => `${f.kind}${f.inherited ? "^" : ""}${f.enabled === false ? "(off)" : ""}`).join(",")}`);

describe("filters each framework states", () => {
  it("ASP.NET: rate limits, CORS, antiforgery and caching on the controller and the action", async () => {
    const src = `[ApiController]
[Route("cars")]
[EnableRateLimiting("fixed")]
[EnableCors("spa")]
public class CarsController : ControllerBase {
  [HttpPost]
  [ValidateAntiForgeryToken]
  public IActionResult Create() => Ok();
  [HttpGet]
  [ResponseCache(Duration = 60)]
  [DisableRateLimiting]
  public IActionResult List() => Ok();
}`;
    const routes: RouteInfo[] = [];
    extractAspnetRoutes((await parseSource(src, "csharp" as never, "C.cs")).rootNode, routes);
    expect(show(routes)).toEqual(["POST /cars: rate-limit^,cors^,csrf", "GET /cars: rate-limit^,cors^,cache,rate-limit(off)"]);
  });

  it("NestJS: interceptors, pipes and throttling", async () => {
    const src = `@Controller('cars')
@UseInterceptors(LoggingInterceptor)
export class CarsController {
  @Post()
  @UsePipes(new ValidationPipe())
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  create() {}
  @Get()
  @SkipThrottle()
  list() {}
}`;
    const routes: RouteInfo[] = [];
    extractNestjsRoutes((await parseSource(src, "typescript" as never, "o.controller.ts")).rootNode, routes);
    expect(show(routes)).toEqual(["POST /cars: logging^,validation,rate-limit", "GET /cars: logging^,rate-limit(off)"]);
  });

  it("Express: a router's rate limiter is inherited by the routes after it; a route's own validator is its own", async () => {
    const src = `const router = express.Router();
router.get("/health", health);
router.use(rateLimit({ windowMs: 60000, max: 10 }));
router.post("/cars", celebrate({ body: schema }), createCar);`;
    const tree = await parseSource(src, "typescript" as never, "routes.ts");
    const routes: RouteInfo[] = [];
    extractExpressRoutes(tree.rootNode, routes);
    applyRouterLevelGuards(tree.rootNode, routes);
    expect(show(routes)).toEqual(["GET /health: ", "POST /cars: rate-limit^,validation"]);
  });
});
