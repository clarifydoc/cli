import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { javaTaint } from "../java-kotlin/taint.js";
import { csharpTaint } from "../csharp/taint.js";
import { phpTaint } from "../php/taint.js";

const found = async (lang: string, file: string, src: string, fn: typeof javaTaint) => {
  const tree = await parseSource(src, lang as any, file);
  return fn(tree, src, file).map((i) => `${i.line} ${i.category}`);
};

describe("handler taint — Java (Spring / JAX-RS)", () => {
  it("follows bound parameters and servlet reads to SQL, command, path, URL and redirect sinks", async () => {
    expect(await found("java", "C.java", `@RestController
class C {
  @GetMapping("/a")
  List<Player> a(@RequestParam String name, @RequestParam int limit) {
    String sql = "SELECT * FROM players WHERE name = '" + name + "'";
    return jdbcTemplate.query(sql, mapper);
  }
  @GetMapping("/b")
  Player b(@PathVariable String id) {
    return jdbcTemplate.queryForObject("SELECT * FROM players WHERE id = ?", mapper, id);
  }
  @PostMapping("/c")
  void c(@RequestBody Job job, HttpServletResponse response) throws Exception {
    Runtime.getRuntime().exec("convert " + job.file);
    response.sendRedirect(job.next);
  }
  @GetMapping("/d")
  byte[] d(HttpServletRequest request) throws Exception {
    String p = request.getParameter("p");
    return Files.readAllBytes(Paths.get("/data", p));
  }
  @GetMapping("/e")
  String e(@RequestParam String n) {
    int k = Integer.parseInt(n);
    repository.update(n);
    return restTemplate.getForObject("http://svc/" + k, String.class);
  }
  void notAHandler(String name) { jdbcTemplate.query("SELECT " + name, mapper); }
}`, javaTaint)).toEqual(["6 sql-injection", "14 command-injection", "15 open-redirect", "20 path-traversal"]);
  });
});

describe("handler taint — C# (ASP.NET)", () => {
  it("follows bound parameters and Request reads; FromServices, parameterized and parsed values are clean", async () => {
    expect(await found("csharp", "C.cs", `public class PlayersController : ControllerBase {
  [HttpGet("a")]
  public IActionResult A([FromQuery] string name, [FromServices] AppDbContext db) {
    var q = $"SELECT * FROM Players WHERE Name = '{name}'";
    using var cmd = new SqlCommand(q, conn);
    return Ok(db.Players.FromSqlRaw("SELECT * FROM Players WHERE Name = {0}", name));
  }
  [HttpGet("b")]
  public IActionResult B(string file) {
    return PhysicalFile(Path.Combine(_root, file), "text/plain");
  }
  [HttpGet("c")]
  public async Task<IActionResult> C() {
    var url = Request.Query["url"];
    var body = await _http.GetStringAsync(url);
    return Redirect(Request.Query["next"]);
  }
  [HttpGet("d")]
  public IActionResult D(string id) {
    var n = int.Parse(id);
    return Ok(_db.Players.FromSqlInterpolated($"SELECT * FROM Players WHERE Id = {n}"));
  }
}`, csharpTaint)).toEqual(["5 sql-injection", "10 path-traversal", "15 ssrf", "16 open-redirect"]);
  });
});

describe("handler taint — PHP (Laravel, plain scripts)", () => {
  it("follows request input and route parameters; quoted and escaped values are clean", async () => {
    expect(await found("php", "C.php", `<?php
class PlayerController extends Controller {
  public function show(Request $request, $id) {
    $name = $request->input('name');
    $rows = DB::select("SELECT * FROM players WHERE name = '$name'");
    $safe = DB::select('SELECT * FROM players WHERE id = ?', [$id]);
    $cached = $this->cache->get($id);
    return redirect($request->input('next'));
  }
  public function export(Request $request) {
    $file = basename($request->input('file'));
    return response()->download('/exports/' . $file);
  }
}
`, phpTaint)).toEqual(["5 sql-injection", "8 open-redirect"]);
    expect(await found("php", "s.php", `<?php
$id = $_GET['id'];
$res = mysqli_query($conn, "SELECT * FROM t WHERE id = " . $id);
$n = intval($_GET['n']);
mysqli_query($conn, "SELECT * FROM t WHERE n = $n");
system('ls ' . $_POST['dir']);
`, phpTaint)).toEqual(["3 sql-injection", "6 command-injection"]);
  });
});

describe("handler taint — the steps a finding carries", () => {
  it("names the parameter or read, each assignment, and the sink", async () => {
    const tree = await parseSource(`class C {
  @GetMapping("/a")
  List<Player> a(@RequestParam String name) {
    String trimmed = name.trim();
    String sql = "SELECT * FROM players WHERE name = '" + trimmed + "'";
    return jdbcTemplate.query(sql, mapper);
  }
}`, "java" as any, "C.java");
    const [issue] = javaTaint(tree, "", "C.java");
    expect(issue!.flow).toEqual([
      { line: 3, note: "request parameter name" },
      { line: 4, note: "trimmed carries it" },
      { line: 5, note: "sql carries it" },
      { line: 6, note: "reaches the SQL text of jdbcTemplate.query()" },
    ]);
  });
});
