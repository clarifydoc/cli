import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { plainPagePath, servedScriptPath, plainPageRoutes, resolvePageTarget } from "./plain-pages.js";
import { readPhpView } from "./views.js";
import { phpMeta } from "./meta.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Classic PHP sites: scripts served at their own path, with the markup of a page around their code. */

const blank = (filePath: string): FileAnalysis =>
  ({ filePath, language: "php", functions: [], classes: [], imports: [], dataSources: [], interactiveElements: [], screens: [], subComponents: [] }) as unknown as FileAnalysis;

async function page(filePath: string, source: string) {
  const a = blank(filePath);
  readPhpView(a, source);
  const tree = await parseSource(source, "php" as never, filePath);
  return { a, routes: plainPageRoutes(tree.rootNode, source, filePath) };
}

describe("plain PHP pages", () => {
  it("serves a script at its path, under a document root when it sits in one", () => {
    expect(plainPagePath("clubs.php")).toBe("/clubs.php");
    expect(plainPagePath("admin/edit_player.php")).toBe("/admin/edit_player.php");
    expect(plainPagePath("site/public/clubs.php")).toBe("/clubs.php");
    expect(plainPagePath("lib/db.php")).toBeNull();
    expect(plainPagePath("application/views/clubs/edit.php")).toBeNull();
    expect(plainPagePath("header.php")).toBeNull();
    expect(plainPagePath("includes/nav.php")).toBeNull();
    expect(servedScriptPath("app/Http/Controllers/ClubController.php", "<?php\nnamespace App;\nclass ClubController {}")).toBeNull();
    expect(servedScriptPath("about.php", "<?php echo 1; ?><p>Linux Kernel</p>")).toBe("/about.php");
    expect(plainPagePath("resources/views/clubs.blade.php")).toBeNull();
  });

  it("resolves relative targets against the page's own directory", () => {
    expect(resolvePageTarget("/admin/edit.php", "save.php")).toBe("/admin/save.php");
    expect(resolvePageTarget("/admin/edit.php", "../players.php?id=3")).toBe("/players.php?id=3");
    expect(resolvePageTarget("/clubs.php", "../x.php")).toBeNull();
    expect(resolvePageTarget("/clubs.php", "/abs.php")).toBeNull();
    expect(resolvePageTarget("/clubs.php", "https://x.test/a.php")).toBeNull();
    expect(resolvePageTarget("/clubs.php", "logo.png")).toBeNull();
  });

  it("reads a page's form, link and fetch, targets resolved, a screen at its own route", async () => {
    const { a, routes } = await page(
      "admin/clubs.php",
      `<?php $q = $_GET['q']; ?>
<form action="save_club.php" method="post"><input type="submit" value="Save"></form>
<a href="../players.php?id=3">Players</a>
<script>fetch('api/ping.php');</script>`,
    );
    const targets = a.dataSources.map((d) => d.name);
    expect(targets).toContain("POST /admin/save_club.php");
    expect(targets).toContain("GET /players.php");
    expect(targets).toContain("GET /admin/api/ping.php");
    expect(a.screens[0]).toMatchObject({ name: "admin/clubs", routePath: "/admin/clubs.php", formType: "PhpPage" });
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /admin/clubs.php"]);
  });

  it("posts a form with no action, or PHP_SELF, to its own route", async () => {
    const { a, routes } = await page(
      "edit_player.php",
      `<?php if ($_POST) { save($_POST['name']); } ?>
<form method="post"><input type="submit" value="Go"></form>
<form action="<?= htmlspecialchars($_SERVER['PHP_SELF']) ?>" method="post"><input type="submit" value="Again"></form>`,
    );
    expect(a.interactiveElements.filter((e) => e.ownViewPost).length).toBeGreaterThanOrEqual(2);
    expect(a.screens[0]!.renderedBy).toEqual([expect.objectContaining({ path: "/edit_player.php" })]);
    expect(routes.map((r) => r.httpMethod).sort()).toEqual(["GET", "POST"]);
  });

  it("routes a script by the input it reads, with no page around it", async () => {
    expect((await page("save_club.php", `<?php $n = $_POST['name'];`)).routes.map((r) => r.httpMethod)).toEqual(["POST"]);
    expect((await page("feed.php", `<?php $n = $_GET['id'];`)).routes.map((r) => r.httpMethod)).toEqual(["GET"]);
    expect((await page("hook.php", `<?php $b = file_get_contents('php://input');`)).routes.map((r) => r.httpMethod)).toEqual(["POST"]);
    expect((await page("any.php", `<?php $n = $_REQUEST['id'];`)).routes.map((r) => r.httpMethod).sort()).toEqual(["GET", "POST"]);
  });

  it("makes no page or route of a library, a class, a comment or a front controller", async () => {
    expect((await page("lib/db.php", `<?php $x = $_POST['a'];`)).routes).toEqual([]);
    expect((await page("helpers.php", `<?php function connect() { return new PDO('x'); }`)).routes).toEqual([]);
    expect((await page("Club.php", `<?php class Club { function f() { return $_POST['a']; } }`)).routes).toEqual([]);
    expect((await page("note.php", `<?php // reads $_POST later`)).routes).toEqual([]);
    const front = await page("public/index.php", `<?php require __DIR__.'/../vendor/autoload.php'; $_GET; $k->handle($request);`);
    expect(front.routes).toEqual([]);
    const lib = await page("db.php", `<?php\n$db = connect();`);
    expect(lib.a.screens).toEqual([]);
  });

  it("is claimed by preprocess only when markup holds something to interact with", () => {
    const pre = phpMeta.preprocess!;
    expect(pre(`<?php $x = 1;`, "db.php")).toBeNull();
    expect(pre(`<html><a href="x.php">x</a></html>`, "index.php")).not.toBeNull();
    expect(pre(`<html><a href="x.php">x</a></html>`, "lib/page.php")).toBeNull();
  });
});
