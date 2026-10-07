import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../../types/analysis.js";
import { commandArgs, commandName, operandText } from "./commands.js";

/** The script's own directory, as scripts spell it: `$(dirname "$0")`, `${BASH_SOURCE%/*}`, … */
const SCRIPT_DIR_RE = /^(?:\$\(\s*dirname\s+["']?\$(?:0|\{?BASH_SOURCE(?:\[0\])?\}?)["']?\s*\)|\$\{BASH_SOURCE(?:\[0\])?%\/\*\}|\$\(\s*cd\s+["']?\$\(\s*dirname\s+[^)]*\)["']?\s*(?:&&|;)\s*pwd\s*\))/;

/**
 * Shell imports:
 *  - `source lib/x.sh` / `. "$(dirname "$0")/lib/x.sh"` — LOADED: its
 *    functions come into scope (the manifest's `importsShareScope`);
 *  - `./scripts/build.sh …` / `bash deploy.sh` — RUN (`executes`): a
 *    dependency, but nothing of it comes into scope.
 * A directory written through a variable the file sets to the script's own
 * (`DIR=$(cd "$(dirname "$0")" && pwd)`) reads as `./`.
 */
export class BashImportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["bash"];

  protected collectImports(root: Node, imports: ImportInfo[]): void {
    const scriptDirVars = new Set<string>();
    const walk = (node: Node) => {
      if (node.type === "variable_assignment") {
        const name = node.childForFieldName("name")?.text;
        const value = node.childForFieldName("value");
        if (name && value && SCRIPT_DIR_RE.test(operandText(value).trim())) scriptDirVars.add(name);
      }
      if (node.type === "command") {
        const line = node.startPosition.row + 1;
        const name = node.childForFieldName("name")?.text ?? "";
        const first = commandArgs(node)[0];
        if ((name === "source" || name === ".") && first) {
          const path = this.scriptPath(operandText(first), scriptDirVars);
          if (path) imports.push(imp(path, line));
        } else if (/^(?:bash|sh|zsh|dash|ksh)$/.test(name) && first && /\.(?:sh|bash)$/.test(operandText(first))) {
          const path = this.scriptPath(operandText(first), scriptDirVars);
          if (path) imports.push({ ...imp(path, line), executes: true });
        } else {
          const run = commandName(node);
          if (run && run.includes("/")) {
            const path = this.scriptPath(run, scriptDirVars);
            if (path && /\.(?:sh|bash)$/.test(path)) imports.push({ ...imp(path, line), executes: true });
          }
        }
      }
      for (const child of node.namedChildren) walk(child);
    };
    walk(root);
  }

  protected collectExports(_node: Node, _exports: ExportInfo[]): void {}

  /**
   * Where a path operand points. Anchored on the script's own directory
   * (`"$(dirname "$0")/lib/x.sh"`, `$DIR/x.sh`) it is relative to the
   * script: `./lib/x.sh`. Written plainly (`./scripts/build.sh`, `lib/x.sh`)
   * it is relative to the directory the script is RUN from — usually the
   * repository root — so it stays unanchored (`scripts/build.sh`) and resolves
   * from the project root or by file name. Null for an absolute path or one
   * still holding an expansion.
   */
  private scriptPath(raw: string, scriptDirVars: ReadonlySet<string>): string | null {
    let p = raw.trim().replace(/^["']|["']$/g, "");
    let anchored = false;
    const dir = SCRIPT_DIR_RE.exec(p);
    if (dir) { p = "." + p.slice(dir[0].length); anchored = true; }
    const v = /^\$\{?(\w+)\}?(?=\/)/.exec(p);
    if (v && scriptDirVars.has(v[1]!)) { p = "." + p.slice(v[0].length); anchored = true; }
    if (/[$`*?]/.test(p) || p.startsWith("/") || p.startsWith("~") || p === "") return null;
    if (!anchored) return p.replace(/^\.\//, "");
    return p.replace(/^\.\/(?=\.\.\/)/, "");
  }
}

const imp = (source: string, line: number): ImportInfo => ({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
