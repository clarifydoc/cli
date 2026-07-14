import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinExtractor } from "./functions-classes.js";

/**
 * `FunctionInfo.localTypes` — declared-type locals of a method body. The
 * symbol linker uses these to resolve calls through typed locals (Strategy 2)
 * and to veto unique-name guesses whose receiver's declared type contradicts
 * the target (Strategy 7).
 */
describe("Java/Kotlin localTypes extraction", () => {
  it("captures Java typed locals and enhanced-for variables, skipping var/String", async () => {
    const src = `package x;
class AccountApiImpl {
  void update(String id) {
    Account existing = repo.find(id);
    var inferred = other();
    String name = existing.getName();
    List<Grant> grants = existing.getGrants();
    for (Grant g : grants) { g.touch(); }
  }
}`;
    const tree = await parseSource(src, "java" as any, "AccountApiImpl.java");
    const classes = new JavaKotlinExtractor().extractClasses(tree, src);
    const locals = classes[0]!.methods[0]!.localTypes ?? [];
    const byName = Object.fromEntries(locals.map((l) => [l.name, l.type]));
    expect(byName["existing"]).toBe("Account");
    expect(byName["grants"]).toBe("List");
    expect(byName["g"]).toBe("Grant");
    expect(byName["inferred"]).toBeUndefined();
    expect(byName["name"]).toBeUndefined();
  });

  it("captures Kotlin explicitly-typed locals only", async () => {
    const src = `package x
class Service {
  fun m(id: Int) {
    val doc: Document = dao.get(id)
    val inferred = dao.other()
  }
}`;
    const tree = await parseSource(src, "kotlin" as any, "Service.kt");
    const classes = new JavaKotlinExtractor().extractClasses(tree, src);
    const locals = classes[0]!.methods[0]!.localTypes ?? [];
    expect(locals).toEqual([{ name: "doc", type: "Document" }]);
  });
});
