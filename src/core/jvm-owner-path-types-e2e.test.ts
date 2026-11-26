import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/**
 * A Java/Kotlin type written through its owner (`Right.Builder`) is the class nested in `Right`'s body: not the
 * `Builder` of another owner, not a top-level `Builder`, and nothing where `Right` holds none.
 */
describe("types written through their owner path, end to end", () => {
  let dir: string;
  let links: Array<{ sourceFile: string; callName: string; targetFile: string; targetSymbol: string }>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-owner-path-"));
    const src = join(dir, "app", "src");
    await mkdir(src, { recursive: true });
    const w = (name: string, text: string) => writeFile(join(src, name), text);
    await w("Left.java", "public class Left {\n  public static class Builder { public void twin() {} }\n}\n");
    await w("Right.java", "public class Right {\n  public static class Builder { public void twin() {} }\n  public static Right.Builder builder() { return new Builder(); }\n}\n");
    await w("Plain.java", "public class Plain { public void other() {} }\n");
    await w("Builder.java", "public class Builder { public void twin() {} }\n");
    await w("Club.java", "import org.immutables.value.Value;\n@Value.Immutable\npublic interface Club { String name(); }\n");
    await w("Garage.java", [
      "public class Garage {",
      "  void field() { Right.Builder b = new Right.Builder(); b.twin(); }",
      "  void param(Left.Builder p) { p.twin(); }",
      "  void ret() { Right.builder().twin(); }",
      "  void typed() { var x = new Left.Builder(); x.twin(); }",
      "  void none() { Plain.Builder b = new Plain.Builder(); b.twin(); }",
      "  void gen(ImmutableClub.Builder p) { p.name(\"a\"); }",
      "}",
    ].join("\n"));
    await w("Garage.kt", [
      "class GarageK {",
      "  fun field() { val b: Right.Builder = Right.Builder(); b.twin() }",
      "  fun none(p: Plain.Builder) { p.twin() }",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    const summary = await loadReportSummary(join(dir, "out"));
    links = (summary.symbolLinks ?? []) as typeof links;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const from = (file: string) => links.filter((l) => l.sourceFile.endsWith(file)).map((l) => `${l.callName} -> ${l.targetFile.split("/").pop()}:${l.targetSymbol}`).sort();

  it("reaches the owner's nested class from a declared local, a parameter, a return type and a construction", () => {
    const java = from("Garage.java");
    expect(java).toContain("b.twin -> Right.java:Right.Builder.twin");
    expect(java).toContain("p.twin -> Left.java:Left.Builder.twin");
    expect(java).toContain("Right.builder().twin -> Right.java:Right.Builder.twin");
    expect(java).toContain("x.twin -> Left.java:Left.Builder.twin");
    expect(java).toContain("new Right.Builder -> Right.java:Right.Builder");
  });

  it("never reaches a namesake when the owner holds no such class", () => {
    const all = [...from("Garage.java"), ...from("Garage.kt")];
    expect(all.filter((l) => /Builder\.twin|Builder$/.test(l) && l.includes("Plain"))).toEqual([]);
    expect(from("Garage.java").filter((l) => l.startsWith("new Plain.Builder"))).toEqual([]);
    // No `Plain.Builder` local or parameter reaches the top-level or another owner's `Builder`.
    expect(from("Garage.kt").filter((l) => l.startsWith("p.twin"))).toEqual([]);
    expect(from("Garage.java").filter((l) => l.startsWith("b.twin") && !l.includes("Right.java"))).toEqual([]);
  });

  it("reaches the generated Immutables builder through the written owner path", () => {
    expect(from("Garage.java")).toContain("p.name -> Club.java:ImmutableClub_Builder.name");
  });

  it("reads a Kotlin type through its owner path too", () => {
    expect(from("Garage.kt")).toContain("b.twin -> Right.java:Right.Builder.twin");
  });
});
