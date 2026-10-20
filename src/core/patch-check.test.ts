import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { checkPatch, renderPatchCheck } from "./patch-check.js";

describe("checking a patch before it is made", () => {
  let dir: string;
  const service = `package shop;
public class OrderService {
  public void place(Order order) {}
  public void place(Order order, boolean express) {}
  public void cancel(String id) {}
}`;
  const controller = `package shop;
public class OrderController {
  private OrderService service;
  public void create(Order o) { service.place(o); }
  public void drop(String id) { service.cancel(id); }
}`;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-patch-"));
    await mkdir(join(dir, "app", "src", "shop"), { recursive: true });
    await writeFile(join(dir, "app", "pom.xml"), "<project><artifactId>shop</artifactId></project>");
    await writeFile(join(dir, "app", "src", "shop", "OrderService.java"), service);
    await writeFile(join(dir, "app", "src", "shop", "OrderController.java"), controller);
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the syntax it breaks and a call no overload accepts, and nothing for what is fine", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const broken = controller
      .replace("service.cancel(id);", "service.cancel(id, true);")
      .replace("service.place(o);", "service.place(o, false); helper(1, 2, 3);")
      .replace("public void drop(String id) {", "public void drop(String id) { if (id == null {");
    const got = await checkPatch(join(dir, "app"), join(dir, "out"), summary.symbolLinks, new Map([["src/shop/OrderController.java", broken]]));
    expect(got.syntax.map((s) => [s.file, s.before, s.errors > 0, s.lines.includes(5)])).toEqual([["src/shop/OrderController.java", 0, true, true]]);
    // place(o, false) matches an overload; cancel(id, true) matches none; helper(…) is not the project's.
    expect(got.arity.map((a) => `${a.call} ${a.passed} → ${a.accepts}`)).toEqual(["service.cancel 2 → 1"]);
    expect(renderPatchCheck(got)).toContain("**arguments** `src/shop/OrderController.java:5` `service.cancel` passes 2; it takes 1");
    // The file as it is: nothing to report.
    expect(await checkPatch(join(dir, "app"), join(dir, "out"), summary.symbolLinks, new Map([["src/shop/OrderController.java", controller]]))).toEqual({ syntax: [], arity: [] });
  });
});
