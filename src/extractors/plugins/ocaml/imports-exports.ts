import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../../types/analysis.js";

/** Modules of the standard library and the compiler — never a file of the project. */
const STDLIB = new Set([
  "Stdlib", "List", "Array", "String", "Bytes", "Char", "Int", "Int32", "Int64", "Float", "Bool", "Option", "Result",
  "Printf", "Format", "Printexc", "Hashtbl", "Map", "Set", "Buffer", "Seq", "Fun", "Lazy", "Queue", "Stack", "Sys",
  "Unix", "Filename", "Random", "Lexing", "Parsing", "Scanf", "Obj", "Gc", "Arg", "Uchar", "Either", "Atomic", "Domain",
  "In_channel", "Out_channel", "StringLabels", "ListLabels", "ArrayLabels", "MoreLabels", "Bigarray", "Complex", "Digest",
]);

/**
 * OCaml names a module, never a file: `open Lwt.Syntax`, `include Base`,
 * `Db.find ~id`. A file is the module of its name (`db.ml` is `Db`), so every
 * module the file opens or refers to is an import of that name — the project's
 * own resolve to their file, a library's (`Dream`, `Lwt`) to its package.
 */
export class OCamlImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["ocaml"];

  protected collectImports(root: Node, imports: ImportInfo[]): void {
    const seen = new Set<string>();
    const add = (name: string, line: number, isNamespace: boolean) => {
      if (STDLIB.has(name) || seen.has(name)) return;
      seen.add(name);
      imports.push({ source: name, specifiers: [name], isDefault: false, isNamespace, isType: false, line });
    };
    // Locally bound module names (`module R = Repo`, functor parameters) are no imports.
    const local = new Set<string>();
    for (const b of root.descendantsOfType(["module_binding", "module_parameter"])) {
      const n = b.namedChildren.find((c) => c.type === "module_name")?.text;
      if (n) local.add(n);
    }
    for (const node of root.descendantsOfType(["open_module", "include_module", "module_path", "extended_module_path"])) {
      // The outermost segment of a path: `Lwt` of `Lwt.Syntax`.
      if (node.parent?.type === "module_path" || node.parent?.type === "extended_module_path") continue;
      const first = (node.type === "open_module" || node.type === "include_module" ? node.namedChildren[0] : node)?.descendantsOfType("module_name")[0]?.text
        ?? (node.namedChildren[0]?.type === "module_name" ? node.namedChildren[0].text : null);
      if (first && !local.has(first)) add(first, node.startPosition.row + 1, node.type === "open_module");
    }
  }

  protected collectExports(_node: Node, _exports: ExportInfo[]): void {}
}
