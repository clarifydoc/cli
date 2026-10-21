import { describe, it, expect } from "vitest";
import "../extractors/registry.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";
import { parseSource, type TreeSitterLanguage } from "../parsers/parser-manager.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { createEmptyAnalysis, type FileAnalysis, type Language } from "../types/analysis.js";
import { restoreTypedReceiverCalls } from "./typed-receivers.js";
import { extractWithRegex } from "./regex-extractor.js";

/** Extract functions/classes the way the per-file pipeline does, then restore. */
async function analyze(src: string, language: TreeSitterLanguage, path: string): Promise<FileAnalysis> {
  await ensureLanguagesLoaded([language]);
  const tree = await parseSource(src, language, path);
  const a = createEmptyAnalysis(path, language as Language);
  a.functions = extractFunctions(tree, src, language);
  a.classes = extractClasses(tree, src, language);
  restoreTypedReceiverCalls(a);
  return a;
}

const callsOf = (a: FileAnalysis, cls: string, method: string): string[] =>
  a.classes.find((c) => c.name === cls)!.methods.find((m) => m.name === method)!.calls.map((c) => c.name);

describe("restoreTypedReceiverCalls — noise-named methods on declared receivers", () => {
  it("PHP: keeps `find`/`send` on typed fields and params, drops them on untyped receivers", async () => {
    const a = await analyze(`<?php
class Svc {
  private PlayerRepository $repo;
  private $items;
  public function __construct(private Notifier $notifier) {}
  public function run(Parser $parser) {
    $u = $this->repo->find(1);
    $this->notifier->send("hi");
    $parser->parse("x");
    $this->items->map(fn($i) => $i);
    return $u;
  }
}`, "php", "Svc.php");
    expect(callsOf(a, "Svc", "run")).toEqual(["this.repo.find", "this.notifier.send", "parser.parse"]);
  });

  it("TypeScript: Array#find on an array-typed field stays noise; a repository's find does not", async () => {
    const a = await analyze(`
class Svc {
  private items: Item[] = [];
  constructor(private readonly repo: PlayerRepository) {}
  run() {
    this.items.find((i) => i.ok);
    return this.repo.find(1);
  }
}`, "typescript", "svc.ts");
    expect(callsOf(a, "Svc", "run")).toEqual(["this.repo.find"]);
  });

  it("restores at the position the walk found the call", async () => {
    const a = await analyze(`<?php
class Svc {
  private PlayerRepository $repo;
  public function run() { $this->a(); $this->repo->find(1); $this->b(); }
}`, "php", "Svc.php");
    expect(callsOf(a, "Svc", "run")).toEqual(["this.a", "this.repo.find", "this.b"]);
  });

  it("regex path: a declared field's `delete` comes back, a bare `delete(x)` does not", async () => {
    await ensureLanguagesLoaded(["dart"]);
    const a = extractWithRegex(`
class Svc {
  final PgRepo _repo;
  Svc(this._repo);
  void run() {
    _repo.delete(1);
    delete(2);
  }
}`, "lib/svc.dart", "dart");
    restoreTypedReceiverCalls(a);
    expect(callsOf(a, "Svc", "run")).toContain("_repo.delete");
    expect(callsOf(a, "Svc", "run")).not.toContain("delete");
  });
});
