import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { terminateAnnotatedDeclarations } from "./kotlin-preprocess.js";
import { JavaKotlinExtractor } from "./functions-classes.js";

const HILT_MODULE = `package a

@Module
@InstallIn(SingletonComponent::class)
abstract class CacheModule {
    @Binds
    abstract fun bindCache(impl: DiskCache): Cache
}

class Unrelated {
    fun x() {}
}
`;

async function classesOf(src: string): Promise<Array<[string, number, number, string[], string[]]>> {
  const tree = await parseSource(src, "kotlin" as any, "X.kt");
  return new JavaKotlinExtractor()
    .extractClasses(tree, src)
    .map((c) => [c.name, c.line, c.endLine, c.decorators, c.methods.map((m) => m.name)]);
}

describe("Kotlin preprocess — annotated top-level declarations", () => {
  it("documents the grammar bug: without the fix the annotated class is lost", async () => {
    // If a tree-sitter-kotlin upgrade fixes this, the preprocess can go.
    expect((await classesOf(HILT_MODULE)).map((c) => c[0])).toEqual(["Unrelated"]);
  });

  it("joins the annotations onto the keyword line and terminates the declaration — rows unchanged", async () => {
    const fixed = terminateAnnotatedDeclarations(HILT_MODULE)!;
    expect(fixed).toBe(`package a



@Module @InstallIn(SingletonComponent::class) abstract class CacheModule {
    @Binds
    abstract fun bindCache(impl: DiskCache): Cache
}

;class Unrelated {
    fun x() {}
}
`);
    expect(fixed.split("\n").length).toBe(HILT_MODULE.split("\n").length);
    expect(await classesOf(fixed)).toEqual([
      ["CacheModule", 5, 8, ["Module", "InstallIn(SingletonComponent::class)"], ["bindCache"]],
      ["Unrelated", 10, 12, [], ["x"]],
    ]);
  });

  it("keeps a controller's annotations when the declaration before it would detach them", async () => {
    const src = `package a
data class PlayerRequest(val name: String, val manager: String?)

// Spring-style controller
@RestController
@RequestMapping("/players")
@PreAuthorize("hasRole('USER')")
class PlayerRoutesController {
    @GetMapping("/")
    fun listPlayers(): List<String> = listOf()
}

fun Application.configureRouting() {}
`;
    const classes = await classesOf(terminateAnnotatedDeclarations(src)!);
    expect(classes[1]).toEqual([
      "PlayerRoutesController", 8, 11,
      ["RestController", "RequestMapping(\"/players\")", "PreAuthorize(\"hasRole('USER')\")"],
      ["listPlayers"],
    ]);
  });

  it("fixes the other misparse shapes: one-line runs, `()` headers, objects, interfaces, no body, functions", async () => {
    const cases: Array<[string, string[]]> = [
      [`package a\n\n@Module @InstallIn(S::class)\nabstract class M {\n    @Binds abstract fun b(i: D): C\n}\n\nclass Y\n`, ["M", "Y"]],
      [`package a\n\n@Module\n@InstallIn(S::class)\nclass M() {\n    fun b(i: D): C = x\n}\n\nclass Y\n`, ["M", "Y"]],
      [`package a\n\n@Module\n@InstallIn(S::class)\nobject M {\n    @Provides fun b(): C = x\n}\n\nclass Y\n`, ["M", "Y"]],
      [`package a\n\n@A\n@B\ninterface M {\n    fun b(): C\n}\n\nclass Y\n`, ["M", "Y"]],
      [`package a\n\n@A\n@B\nclass M\n\nclass Y {\n    fun x() {}\n}\n`, ["M", "Y"]],
      [`package a\n\n/** doc */\n@A\n@B\nclass M {\n    fun q() {}\n}\n\n// c\nclass Y\n`, ["M", "Y"]],
      [`data class U(val m: String?)\n// c\n@OptIn(X::class)\nfun f() {\n    g()\n}\nclass Y\n`, ["U", "Y"]],
    ];
    for (const [src, names] of cases) {
      const fixed = terminateAnnotatedDeclarations(src);
      expect(fixed, src).not.toBeNull();
      expect((await classesOf(fixed!)).map((c) => c[0]), src).toEqual(names);
    }
  });

  it("does not terminate a declaration whose last line continues onto the next", () => {
    const src = `@A\nfun f(): Int =\n    1 +\n    2\nfun g() {}\n`;
    expect(terminateAnnotatedDeclarations(src)).toBe(`\n@A fun f(): Int =\n    1 +\n    2\n;fun g() {}\n`);
  });

  it("drops comments inside the run, keeping their line breaks; keeps a run whose string spans lines as it is", () => {
    expect(terminateAnnotatedDeclarations(`@A /* x */\n@B // y\nclass X\nclass Y\n`)).toBe(`\n\n@A @B class X\n;class Y\n`);
    expect(terminateAnnotatedDeclarations(`@A("""a\nb""")\nclass X\nclass Y\n`)).toBe(`@A("""a\nb""")\nclass X\n;class Y\n`);
  });

  it("skips braces inside strings, templates, chars and nested comments", () => {
    const src = `@A @B\nclass X(\n  val a: String = "}{",\n) : I,\n  J {\n  val s = "\${ "}" }"\n  val r = """ } """\n  val c = '}'\n  /* } /* nested } */ */\n}\nclass Y\n`;
    const fixed = terminateAnnotatedDeclarations(src)!;
    expect(fixed.endsWith("*/ */\n}\n;class Y\n")).toBe(true);
    expect(fixed.split("\n").length).toBe(src.split("\n").length);
  });

  it("leaves alone: files with no top-level annotation, file annotations, nested members, terminated declarations", () => {
    expect(terminateAnnotatedDeclarations(`class X {\n  @A\n  @B\n  fun f() {}\n}\nclass Y {}`)).toBeNull();
    expect(terminateAnnotatedDeclarations(`@file:JvmName("x")\npackage a\nclass X {}`)).toBeNull();
    expect(terminateAnnotatedDeclarations(`@A class X {\n};\nclass Y`)).toBeNull();
  });

  it("gives up (no change) on an unterminated literal", () => {
    expect(terminateAnnotatedDeclarations(`@A\n@B\nclass X {\n  val s = """x\n}\n`)).toBeNull();
  });
});

describe("an annotated declaration with a one-line body", () => {
  it("keeps the class, its members and its annotation, on their own lines", async () => {
    const raw = `package app\n\n@Suppress("unused")\nclass K { fun x() = 1 }\n@Keep object O { fun y() = "}" }\n`;
    const src = terminateAnnotatedDeclarations(raw)!;
    expect(src.split("\n").length).toBe(raw.split("\n").length);
    const tree = await parseSource(src, "kotlin" as any, "X.kt");
    const classes = new JavaKotlinExtractor().extractClasses(tree, src);
    expect(classes.map((c) => [c.name, c.line, c.methods.map((m) => m.name), c.decorators])).toEqual([
      ["K", 4, ["x"], ['Suppress("unused")']],
      ["O", 5, ["y"], ["Keep"]],
    ]);
  });
});
