import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { PhpExtractor } from "./functions-classes.js";
import type { ClassInfo } from "../../../types/analysis.js";

/**
 * CodeIgniter loads models dynamically (`$this->load->model('x')`), so
 * `$this->x_model->method()` has no declared type and the call linker could not
 * follow the controller→model edge — the edge that carries the DB tier into
 * Call Traces. The extractor synthesizes a typed property so the injection map
 * (which reads `cls.properties`) binds it.
 */
async function classesOf(src: string): Promise<ClassInfo[]> {
  const tree = await parseSource(src, "php" as any, "C.php");
  return new PhpExtractor().extractClasses(tree, src);
}

describe("CodeIgniter load->model synthetic injection properties", () => {
  it("adds a Ucfirst-typed property for each loaded model", async () => {
    const SRC = `<?php
class Site extends JAR_Controller {
  function show() {
    $this->load->model('customers_model');
    $this->load->model('products_model');
    return $this->customers_model->get_customer(1);
  }
}`;
    const [cls] = await classesOf(SRC);
    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, p.type]));
    expect(byName["customers_model"]).toBe("Customers_model");
    expect(byName["products_model"]).toBe("Products_model");
  });

  it("honors the alias arg and strips a subdirectory path", async () => {
    const SRC = `<?php
class Admin extends JAR_Controller {
  function init() {
    $this->load->model('reports/sales_model', 'sales');
  }
}`;
    const [cls] = await classesOf(SRC);
    const byName = Object.fromEntries(cls!.properties.map((p) => [p.name, p.type]));
    // Bound to the alias object name; class is Ucfirst of the file basename.
    expect(byName["sales"]).toBe("Sales_model");
    expect(byName["sales_model"]).toBeUndefined();
  });

  it("does not invent properties for non-CI PHP", async () => {
    const SRC = `<?php
class Plain {
  public string $name;
  function go() { return $this->name; }
}`;
    const [cls] = await classesOf(SRC);
    expect(cls!.properties.map((p) => p.name)).toEqual(["name"]);
  });
});
