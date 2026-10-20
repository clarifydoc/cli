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

@app.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create(user: UserIn):
    return user

@app.get("/users/{id}")
def show(id: int) -> UserOut:
    return find(id)

@app.delete("/users/{id}", status_code=204)
def remove(id: int) -> None:
    pass

@app.get("/raw")
def raw() -> JSONResponse:
    return JSONResponse({})
`)).toEqual([
      'POST /users [{"status":201,"type":"UserOut"}]',
      'GET /users/{id} [{"status":null,"type":"UserOut"}]',
      'DELETE /users/{id} [{"status":204}]',
      "GET /raw null",
    ]);
  });

  it("Spring: the return type unwrapped and @ResponseStatus", async () => {
    expect(await answers(javaKotlinRouteExtractor, "java", "UserController.java", `@RestController
@RequestMapping("/users")
public class UserController {
  @GetMapping("/{id}")
  public ResponseEntity<UserDto> show(@PathVariable Long id) { return ResponseEntity.ok(find(id)); }
  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Mono<UserDto> create(@RequestBody UserIn in) { return save(in); }
  @GetMapping
  public Flux<UserDto> list() { return all(); }
  @DeleteMapping("/{id}")
  public ResponseEntity<Void> remove(@PathVariable Long id) { return ResponseEntity.noContent().build(); }
}`)).toEqual([
      'GET /users/{id} [{"status":null,"type":"UserDto"}]',
      'POST /users [{"status":201,"type":"UserDto"}]',
      'GET /users [{"status":null,"type":"List<UserDto>"}]',
      "DELETE /users/{id} null",
    ]);
  });

  it("ASP.NET: ProducesResponseType, ActionResult<T> and the result helpers returned", async () => {
    expect(await answers(csharpRouteExtractor, "csharp", "UsersController.cs", `[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase {
  [HttpGet("{id}")]
  public async Task<ActionResult<UserDto>> Get(int id) {
    var u = await _repo.Find(id);
    if (u == null) return NotFound();
    return Ok(u);
  }
  [HttpPost]
  [ProducesResponseType(typeof(UserDto), StatusCodes.Status201Created)]
  public IActionResult Create(UserIn dto) { return CreatedAtAction(nameof(Get), new { id = 1 }, dto); }
  [HttpDelete("{id}")]
  public IActionResult Delete(int id) { return NoContent(); }
}`)).toEqual([
      'GET /api/users/{id} [{"status":null,"type":"UserDto"},{"status":404},{"status":200}]',
      'POST /api/users [{"status":201,"type":"UserDto"}]',
      'DELETE /api/users/{id} [{"status":204}]',
    ]);
  });
});
