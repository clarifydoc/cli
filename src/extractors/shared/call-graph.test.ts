import { describe, it, expect } from "vitest";
import type { Node } from "web-tree-sitter";
import "../registry.js"; // side effect: registers grammars and every plugin's call hooks
import { ensureLanguagesLoaded } from "../registry.js";
import { parseSource, type TreeSitterLanguage } from "../../parsers/parser-manager.js";
import { extractCalls } from "./call-graph.js";

/** Calls extracted from the first node of `type` — the way a plugin passes a function body. */
async function callsIn(src: string, language: TreeSitterLanguage, type: string, field = "body"): Promise<string[]> {
  await ensureLanguagesLoaded([language]);
  const tree = await parseSource(src, language, "f");
  const find = (n: Node): Node | null => {
    if (n.type === type) return n;
    for (const c of n.children) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const fn = find(tree.rootNode)!;
  return extractCalls(fn.childForFieldName(field), language).map((c) => c.name);
}

// An identifier passed as an argument is recorded as a call so that
// `items.map(formatPlayer)` links to formatPlayer. A name the function binds
// itself is a value, not a reference to a definition — recorded, the linker
// resolved it by name or through a factory alias to an unrelated function.
describe("extractCalls — callback-argument references", () => {
  it("TypeScript: keeps function references, drops parameters, locals, loop and arrow variables", async () => {
    expect(await callsIn(`
function setup(items, { player }, [first], ...rest) {
  const onClick = () => kickBall();
  const client = new ApiClient();
  let count; count = 1;
  button.on("click", onClick);
  save(items, player, first, rest, client, count);
  items.forEach(renderItem);
  register(helper);
  items.map(item => show(item));
  for (const it of items) consume(it);
  try { run() } catch (err) { report(err) }
}`, "typescript", "function_declaration")).toEqual([
      // forEach/map themselves are NOISE_CALLS; their callback arguments are not.
      "ApiClient", "button.on", "onClick", "save", "renderItem",
      "register", "helper", "show", "consume", "run", "report",
    ]);
  });

  it("TypeScript: a class method's parameters bind too", async () => {
    expect(await callsIn(`
class Svc {
  load(id: string, opts?: Options) { return this.repo.fetch(id, opts, mapRow); }
}`, "typescript", "method_definition")).toEqual(["this.repo.fetch", "mapRow"]);
  });

  it("Python: drops parameters, assignment and loop targets, with/except aliases", async () => {
    expect(await callsIn(`
def handler(self, request, player_id: int, *args, page=1, **kw):
    data = load(player_id)
    a, (b, c) = partition(data)
    for row in rows:
        emit(row)
    with open(path) as fh:
        read_config(fh)
    try:
        pass
    except Exception as err:
        log_error(err)
    total = 0
    total += 1
    executor.submit(process)
    register(self, request, args, page, kw, a, b, c, total, Depends)
`, "python", "function_definition")).toEqual([
      "load", "partition", "emit", "open", "path", "read_config", "log_error",
      "executor.submit", "process", "register", "Depends",
    ]);
  });

  it("Python: a lambda bound to a name is a function, so passing it stays a reference", async () => {
    expect(await callsIn(`
def wire(app):
    on_ready = lambda: start()
    app.subscribe(on_ready)
`, "python", "function_definition")).toEqual(["app.subscribe", "on_ready"]);
  });

  it("Java: drops parameters, locals, enhanced-for and catch variables", async () => {
    expect(await callsIn(`
class A {
  void m(Car car, String... tags) {
    Driver driver = repo.load(car);
    for (Part part : car.parts()) audit(part);
    try { deliver(car, driver, tags); } catch (IOException e) { alert(e, fallback); }
  }
}`, "java", "method_declaration")).toEqual([
      "repo.load", "car.parts", "audit", "deliver", "alert", "fallback",
    ]);
  });
});

describe("classifyCalls — the file's own code is not a DB call by name", () => {
  const classify = async (names: string[], language: TreeSitterLanguage, local: string[] = []) => {
    const { classifyCalls } = await import("./call-graph.js");
    const calls = names.map((name, i) => ({ name, kind: "internal" as const, target: null, line: i + 1 }));
    return classifyCalls(calls, [], language, undefined, new Set(local)).map((c) => `${c.name}:${c.kind}`);
  };

  it("keeps a call into a local definition internal, whatever its method is called", async () => {
    // `get` and `create` are in the DB method-name list; here they are the
    // file's own namespace object and function, which the linker must reach.
    expect(await classify(["requests.get", "create", "db.query"], "typescript", ["requests", "requests.get", "create"]))
      .toEqual(["requests.get:internal", "create:internal", "db.query:database"]);
  });

  it("does not read a method on this/self as database evidence by its name alone", async () => {
    expect(await classify(["this.exec", "self.repo.update", "cache.get"], "python"))
      .toEqual(["this.exec:internal", "self.repo.update:internal", "cache.get:database"]);
  });
});
