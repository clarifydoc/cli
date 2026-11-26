import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";

export class CSharpImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["csharp"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {
      if (child.type === "using_directive") {
        imports.push(this.parseUsingDirective(child));
      }
    }
  }

  /** Parse `using System.Linq;`, `using static System.Math;`, `using Foo = Bar.Baz;` */
  /**
   * A file found by the name of its type (`using static Fx.Tools.Parts;` → `Parts.cs`) is the import's only when
   * the namespace it declares is the one the source names (`importPath`, `nestedPackageLookup`): a namesake
   * `Parts` of another namespace is never opened, and a qualified `Parts.Tune()` over classes of several
   * namespaces takes the one the compiler's lookup (`nestedPackageFile`) decides, else no link.
   *
   * `extern alias`: the qualifier is the assembly, not part of the name. `using LeagueV1::Com.Example.League;`
   * imports the namespace after `::`, and `LeagueV1::Com.Example.League.Club.Sign()` (or `LeagueV1::Ns.Club`)
   * names the call without it (two assemblies declaring one namespace stay undistinguished).
   *
   * `using static`: the linker (`projectStaticScopes`) reads the project-wide statics and a `global using static`
   * of any file as a scope every file of the sub-project has for bare calls, as a file-level `using static` is; an
   * implicit import counts as a static only when it names a class of the project. A `using static` source is
   * normalized (no spacing, no `global::`) and the linker names a nested static class through the classes whose
   * lines enclose it before matching it (`League.Outer.Inner`).
   */
  private parseUsingDirective(node: Node): ImportInfo {
    let isStatic = false;
    let source = "";
    let alias: string | null = null;

    // `using Alias = Namespace.Type;` — the grammar spells the alias as an
    // identifier before `=` (no `name_equals` node in every version).
    const eq = node.children.findIndex((c) => c.type === "=");
    if (eq > 0) {
      const name = node.children.slice(0, eq).reverse().find((c) => c.type === "identifier");
      if (name) alias = name.text;
    }

    // Walk children to extract the namespace via AST rather than text regex
    for (const [i, child] of node.children.entries()) {
      if (eq > 0 && i < eq) continue;

      // "static" keyword
      if (child.text === "static") {
        isStatic = true;
        continue;
      }

      // The namespace/type name: qualified_name, identifier, or name_equals (for alias)
      if (child.type === "qualified_name" || child.type === "identifier_name") {
        source = child.text;
        continue;
      }
      if (child.type === "identifier" && !source) {
        source = child.text;
        continue;
      }

      // Alias: `using Alias = Namespace.Type`
      if (child.type === "name_equals") {
        alias = child.childForFieldName("name")?.text ?? null;
        continue;
      }
    }

    // Fallback to the `name` field
    if (!source) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        source = nameNode.text;
      }
    }

    // Last resort: strip keywords from text
    if (!source) {
      source = node.text
        .replace(/^using\s+/, "")
        .replace(/^static\s+/, "")
        .replace(/;$/, "")
        .trim();
    }

    // `global::League.X`, `League . X`: the name the compiler reads.
    // `using LeagueV1::Com.Example.League;` (an `extern alias`) names the namespace after the qualifier.
    source = source.replace(/\s+/g, "").replace(/^[A-Za-z_]\w*::/, "");

    const specifiers = alias ? [alias] : [];

    return {
      source,
      specifiers,
      isDefault: false,
      isNamespace: !isStatic && !alias,
      isType: false,
      line: node.startPosition.row + 1,
      // `using static League.Scoring.Scorer;`: the type's static members, called bare.
      ...(isStatic && !alias && source.includes(".") ? { inScope: { module: source } } : {}),
      // `global using League.Clubs;` (C# 10) imports it into every file of the project.
      ...(node.children.some((c) => c.type === "global" || c.text === "global") ? { projectWide: true as const } : {}),
    };
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkCsharpNode(node, exports);
  }

  private walkCsharpNode(node: Node, exports: ExportInfo[]): void {
    for (const child of node.children) {

      if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration"
      ) {
        const body = child.childForFieldName("body");
        if (body) this.walkCsharpNode(body, exports);
        this.walkCsharpNode(child, exports);
      } else if (child.type === "class_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (this.isPublic(child)) {
          exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "interface_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (this.isPublic(child)) {
          exports.push({ name, kind: "interface", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "enum_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (this.isPublic(child)) {
          exports.push({ name, kind: "enum", line: child.startPosition.row + 1 });
        }
      }
    }
  }

  private isPublic(node: Node): boolean {
    for (const child of node.children) {
      if (child.type === "modifier" && child.text === "public") return true;
    }
    return true; // Default to treating as exported
  }
}
