import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractCalls } from "../../shared/call-graph.js";
import { phpViewKey, phpViewMarkup, readPhpView } from "./views.js";
import { CodeIgniterViewResolver } from "./view-resolver.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * CodeIgniter views are PHP mixed into HTML: the PHP parser saw only the code
 * between the tags, so 473 views of a real app (real-repo FP) gave no screen,
 * no form, no link — and 806 of its 890 routes read as uncalled.
 */
const VIEW = `<? $this->load->view('embeds/garage_header'); ?>
<h2>Update car</h2>
<ul class="breadcrumb">
  <li><a href="<?=base_url();?>admin/cars">Cars</a></li>
  <li><a href="<?=base_url();?>admin/cars/view/<?=$car->car_id?>">(#<?=$car->car_id?>)</a></li>
  <li><a href="<?= site_url('admin/garages') ?>">Garages</a></li>
  <li><a href="<?=$back_url?>">Back</a></li>
</ul>
<?=form_open_multipart('admin/cars/car_update/'.$car->car_id, array('class' => 'form-horizontal'));?>
  <?=form_input('plate', set_value('plate', $car->plate), 'id="plate"');?>
  <button type="submit" class="btn">Save</button>
<?=form_close();?>
<?=anchor('admin/cars/delete/'.$car->car_id, 'Delete car');?>
<script>
  $('#model').change(function() {
    $.get('/admin/cars/models_grouped/', {brand_id: this.value}, function(data) {});
    $.post('/admin/cars/engine_pdf/<?=$car->car_id?>', $data);
    $.ajax({
      type: 'POST',
      url: '/admin/cars/tyres/' + tyreId,
    });
  });
</script>
`;

async function viewAnalysis(source: string, filePath: string): Promise<FileAnalysis> {
  const tree = await parseSource(source, "php" as never, filePath);
  const a = {
    filePath,
    language: "php",
    functions: [{ name: "<setup>", params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: extractCalls(tree.rootNode, "php"), line: 1, endLine: 1 }],
    classes: [],
    imports: [],
    dataSources: [],
    interactiveElements: [],
    screens: [],
    subComponents: [],
  } as unknown as FileAnalysis;
  readPhpView(a, source);
  return a;
}

describe("plain-PHP views", () => {
  it("knows a view by its path under views/, never a Blade template", () => {
    expect(phpViewKey("application/views/cars/update.php")).toBe("cars/update");
    expect(phpViewKey("app/Views/garages/list.php")).toBe("garages/list");
    expect(phpViewKey("resources/views/cars/index.blade.php")).toBeNull();
    expect(phpViewKey("application/controllers/cars.php")).toBeNull();
  });

  it("rewrites each PHP tag to what it prints where a URL is concerned, lines kept", () => {
    const markup = phpViewMarkup(VIEW);
    expect(markup.split("\n").length).toBe(VIEW.split("\n").length);
    expect(markup).toContain('<a href="/admin/cars">');
    expect(markup).toContain('<a href="/admin/cars/view/{{php}}">');
    expect(markup).toContain('<a href="/admin/garages">');
    expect(markup).toContain('<form action="/admin/cars/car_update/{{php}}" method="post">');
    expect(markup).toContain('<a href="/admin/cars/delete/{{php}}">Delete car</a>');
    expect(markup).toContain("</form>");
  });

  it("turns forms, submit buttons, links and inline AJAX into calls the route linker joins", async () => {
    const a = await viewAnalysis(VIEW, "application/views/cars/update.php");
    expect(a.dataSources.map((d) => d.name)).toEqual([
      "GET /admin/cars",
      "GET /admin/cars/view/:param",
      "GET /admin/garages",
      "POST /admin/cars/car_update/:param",
      "GET /admin/cars/delete/:param",
      "GET /admin/cars/models_grouped/",
      "POST /admin/cars/engine_pdf/:param",
      "POST /admin/cars/tyres/:param",
    ]);
    // The submit button sends its form's request, under the form's handler.
    const save = a.interactiveElements.find((e) => e.caption === "Save");
    expect(save?.request).toEqual({ method: "POST", target: "/admin/cars/car_update/:param" });
    // Script calls sit inside one pseudo-function for their block.
    const script = a.functions.find((f) => f.name.startsWith("<script:"))!;
    for (const d of a.dataSources.filter((x) => x.target?.includes("models_grouped") || x.target?.includes("engine_pdf"))) {
      expect(d.line).toBeGreaterThanOrEqual(script.line);
      expect(d.line).toBeLessThanOrEqual(script.endLine);
    }
  });

  it("is a screen named for its path, composed of the sub-views it loads", async () => {
    const a = await viewAnalysis(VIEW, "application/views/cars/update.php");
    expect(a.screens).toHaveLength(1);
    expect(a.screens[0]).toMatchObject({ name: "cars/update", formType: "PhpView", caption: "Update car" });
    expect(a.screens[0]!.navigatesTo).toContain("/admin/cars");
    expect(a.subComponents.map((s) => s.name)).toEqual(["embeds/garage_header"]);
    // A header piece is no screen; a mail body without controls neither.
    expect((await viewAnalysis(`<nav><a href="<?=base_url()?>cars">Cars</a></nav>`, "application/views/embeds/garage_header.php")).screens).toEqual([]);
    expect((await viewAnalysis(`<p>Your car <?=$plate?> is ready.</p>`, "application/views/cars/ready_notice.php")).screens).toEqual([]);
  });

  it("links a controller method to the view it loads, and a view to its pieces", async () => {
    const ctl = `<?php
class Cars extends CI_Controller {
  function update($id) { $data = []; $this->load->view('cars/update', $data); }
  function missing() { $this->load->view('cars/nowhere'); }
}`;
    const tree = await parseSource(ctl, "php" as never, "application/controllers/admin/cars.php");
    const method = (name: string) => {
      const node = tree.rootNode.descendantsOfType("method_declaration").find((m) => m.childForFieldName("name")?.text === name)!;
      return { name, calls: extractCalls(node.childForFieldName("body"), "php"), line: node.startPosition.row + 1 };
    };
    const controller = { filePath: "application/controllers/admin/cars.php", functions: [], classes: [{ name: "Cars", methods: [method("update"), method("missing")] }] } as unknown as FileAnalysis;
    expect(controller.classes[0]!.methods[0]!.calls.find((c) => c.key)?.key).toBe("ci-view:cars/update");
    const view = await viewAnalysis(VIEW, "application/views/cars/update.php");
    const header = await viewAnalysis(`<nav></nav><? echo 1; ?>`, "application/views/embeds/garage_header.php");
    const links = new CodeIgniterViewResolver().resolve([controller, view, header]);
    expect(links.map((l) => `${l.sourceSymbol} → ${l.targetFile}`).sort()).toEqual([
      "<setup> → application/views/embeds/garage_header.php",
      "Cars.update → application/views/cars/update.php",
    ]);
  });
});
