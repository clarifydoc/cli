import { describe, it, expect } from "vitest";
import "./registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../parsers/parser-manager.js";
import { pythonRouteExtractor } from "./plugins/python/routes.js";
import { javaKotlinRouteExtractor } from "./plugins/java-kotlin/routes/index.js";
import { csharpRouteExtractor } from "./plugins/csharp/routes/aspnet.js";
import type { RouteExtractor } from "./routes/base.js";
import type { RouteFact } from "../types/analysis.js";

/** What a route answers, as each server framework states it (RouteInfo.responses). */
async function answers(extractor: RouteExtractor, language: string, file: string, src: string): Promise<string[]> {
  const tree = await parseSource(src, language as any, file);
  const facts: RouteFact[] = [];
  return extractor.extractRoutes(tree, src, file, facts).map((r) => `${r.httpMethod} ${r.path} ${JSON.stringify(r.responses ?? null)}`);
}

describe("route responses", () => {
  it("FastAPI: response_model, status_code and the return annotation", async () => {
    expect(await answers(pythonRouteExtractor, "python", "app/main.py", `from fastapi import FastAPI, status
app = FastAPI()

@app.post("/players", response_model=PlayerOut, status_code=status.HTTP_201_CREATED)
def create(player: PlayerIn):
    return player

@app.get("/players/{id}")
def show(id: int) -> PlayerOut:
    return find(id)

@app.delete("/players/{id}", status_code=204)
def remove(id: int) -> None:
    pass

@app.get("/raw")
def raw() -> JSONResponse:
    return JSONResponse({})
`)).toEqual([
      'POST /players [{"status":201,"type":"PlayerOut"}]',
      'GET /players/{id} [{"status":null,"type":"PlayerOut"}]',
      'DELETE /players/{id} [{"status":204}]',
      "GET /raw null",
    ]);
  });

  it("Spring: the return type unwrapped and @ResponseStatus", async () => {
    expect(await answers(javaKotlinRouteExtractor, "java", "PlayerController.java", `@RestController
@RequestMapping("/players")
public class PlayerController {
  @GetMapping("/{id}")
  public ResponseEntity<PlayerDto> show(@PathVariable Long id) { return ResponseEntity.ok(find(id)); }
  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Mono<PlayerDto> create(@RequestBody PlayerIn in) { return save(in); }
  @GetMapping
  public Flux<PlayerDto> list() { return all(); }
  @DeleteMapping("/{id}")
  public ResponseEntity<Void> remove(@PathVariable Long id) { return ResponseEntity.noContent().build(); }
}`)).toEqual([
      'GET /players/{id} [{"status":null,"type":"PlayerDto"}]',
      'POST /players [{"status":201,"type":"PlayerDto"}]',
      'GET /players [{"status":null,"type":"List<PlayerDto>"}]',
      "DELETE /players/{id} null",
    ]);
  });

  it("ASP.NET: ProducesResponseType, ActionResult<T> and the result helpers returned", async () => {
    expect(await answers(csharpRouteExtractor, "csharp", "PlayersController.cs", `[ApiController]
[Route("api/players")]
public class PlayersController : ControllerBase {
  [HttpGet("{id}")]
  public async Task<ActionResult<PlayerDto>> Get(int id) {
    var u = await _repo.Find(id);
    if (u == null) return NotFound();
    return Ok(u);
  }
  [HttpPost]
  [ProducesResponseType(typeof(PlayerDto), StatusCodes.Status201Created)]
  public IActionResult Create(PlayerIn dto) { return CreatedAtAction(nameof(Get), new { id = 1 }, dto); }
  [HttpDelete("{id}")]
  public IActionResult Delete(int id) { return NoContent(); }
}`)).toEqual([
      'GET /api/players/{id} [{"status":null,"type":"PlayerDto"},{"status":404},{"status":200}]',
      'POST /api/players [{"status":201,"type":"PlayerDto"}]',
      'DELETE /api/players/{id} [{"status":204}]',
    ]);
  });
});
