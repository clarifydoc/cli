import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../../types/analysis.js";
import { callArgs, callName, stringValue } from "./syntax.js";

/**
 * `library(dplyr)` / `require("DBI")` / `requireNamespace("x")` bring a
 * package in; `source("R/db.R")` LOADS a file into the caller's scope (the
 * manifest's `importsShareScope`) — its path is relative to the working
 * directory, usually the project root, so it stays unanchored. Read anywhere
 * in the file (`source()` inside a function is common).
 */
export class RImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["r"];

  protected collectImports(root: Node, imports: ImportInfo[]): void {
    for (const call of root.descendantsOfType("call")) {
      const name = callName(call);
      if (!name) continue;
      const first = callArgs(call)[0]?.value;
      const line = call.startPosition.row + 1;
      if (/^(?:library|require|requireNamespace|suppressPackageStartupMessages\.library)$/.test(name) && first) {
        const pkg = first.type === "identifier" ? first.text : stringValue(first);
        if (pkg) imports.push({ source: pkg, specifiers: [], isDefault: false, isNamespace: true, isType: false, line });
      } else if ((name === "source" || name === "sys.source") && first) {
        const path = stringValue(first);
        if (path && !/^(?:https?:|\/|~)/.test(path)) imports.push({ source: path.replace(/^\.\//, ""), specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
      }
    }
  }

  protected collectExports(_node: Node, _exports: ExportInfo[]): void {}
}
