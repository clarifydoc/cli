import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractCalls } from "../../shared/call-graph.js";
import { PhpImportExportExtractor } from "./imports-exports.js";

async function imports(src: string) {
  const tree = await parseSource(src, "php" as never, "a.php");
  return new PhpImportExportExtractor().extractImports(tree, src).map((i) => [i.source, i.line]);
}

describe("PHP includes", () => {
  it("reads require/include paths the file spells statically, wherever they sit", async () => {
    expect(await imports(`<?php
require_once __DIR__ . '/lib/db.php';
include 'inc/header.php';
require dirname(__FILE__) . "/x.php";
require_once(dirname(__DIR__, 2) . '/vendor/autoload.php');
function page() {
  if (true) { include_once './partials/nav.php'; }
}
`)).toEqual([
      ["./lib/db.php", 2],
      ["inc/header.php", 3],
      ["./x.php", 4],
      ["../../vendor/autoload.php", 5],
      ["partials/nav.php", 7],
    ]);
  });

  it("refuses a path holding a variable, an absolute path, or no file name", async () => {
    expect(await imports(`<?php
include_once "inc/$name.php";
require $config;
require '/etc/app/config.php';
require dirname(__DIR__) . 'config.php';
require __DIR__;
`)).toEqual([]);
  });

  it("keeps namespace imports beside the includes", async () => {
    expect(await imports(`<?php
namespace App;
use App\\Models\\Player;
require_once __DIR__ . '/helpers.php';
`)).toEqual([["App\\Models\\Player", 3], ["./helpers.php", 4]]);
  });
});

describe("PHP use declarations", () => {
  it("tells a function or constant import from a type import, in groups too", async () => {
    const tree = await parseSource(`<?php
use function App\\money;
use const App\\RATE;
use App\\Models\\Player;
use App\\{Models\\Game, function helpers\\fmt};
`, "php" as never, "a.php");
    const out = new PhpImportExportExtractor().extractImports(tree, "").map((i) => [i.source, i.specifiers[0], i.isType]);
    expect(out).toEqual([
      ["App\\money", "money", false],
      ["App\\RATE", "RATE", false],
      ["App\\Models\\Player", "Player", true],
      ["App\\Models\\Game", "Game", true],
      ["App\\helpers\\fmt", "fmt", false],
    ]);
  });
});

describe("PHP calls", () => {
  it("records an unqualified function call and a construction", async () => {
    const tree = await parseSource(`<?php function f() { $u = find_player(1); $r = new Report(); return \\App\\fmt($u); }`, "php" as never, "a.php");
    const body = tree.rootNode.descendantsOfType("compound_statement")[0]!;
    expect(extractCalls(body, "php").map((c) => c.name)).toEqual(["find_player", "new Report", "\\App\\fmt"]);
  });
});

describe("PHP includes under an application root constant", () => {
  it("reads APPPATH / BASEPATH / ABSPATH paths as tails the resolver matches by suffix", async () => {
    expect(await imports(`<?php
require_once APPPATH.'/libraries/gearbox/Gearbox.php';
include BASEPATH . 'helpers/race_helper.php';
require_once(ABSPATH . 'wp-admin/includes/pit.php');
require APPPATH . $dir . '/x.php';
`)).toEqual([
      ["libraries/gearbox/Gearbox.php", 2],
      ["helpers/race_helper.php", 3],
      ["wp-admin/includes/pit.php", 4],
    ]);
  });
});
