import type { Node, Tree } from "web-tree-sitter";
import type { ModuleBindingInfo } from "../../../types/analysis.js";
import { isBuiltinType } from "../../shared/builtin-types.js";
import { barePascalTypeName, fieldChildren } from "./di.js";

/** Sections whose `var` block declares unit-level variables, and whether a `uses` of the unit sees them. */
const SECTIONS: ReadonlyMap<string, boolean> = new Map([
  ["interface", true],
  ["implementation", false],
  // A program's or library's own globals: nothing can `uses` a program.
  ["program", false],
  ["library", false],
]);

/**
 * The typed variables a unit declares outside every routine: `var dmLeague: TdmLeague;`
 * in the interface section is what `dmLeague.SaveClub` in any unit that `uses` it
 * calls through; one in the implementation section only the unit's own routines see.
 * Only a named type is kept (not `array of`, `^T` or a builtin): a receiver needs a class.
 */
export function pascalModuleBindings(tree: Tree): ModuleBindingInfo[] {
  const out: ModuleBindingInfo[] = [];
  const visit = (node: Node, exported: boolean | null) => {
    for (const child of node.children) {
      const section = SECTIONS.get(child.type);
      if (section !== undefined) {
        visit(child, section);
        continue;
      }
      if (child.type === "unit" || child.type === "root") {
        visit(child, exported);
        continue;
      }
      if (child.type !== "declVars" || exported === null) continue;
      for (const v of child.children) {
        if (v.type !== "declVar") continue;
        const type = v.childForFieldName("type");
        if (!type || type.child(0)?.type !== "typeref") continue;
        const written = type.text.trim();
        const simple = barePascalTypeName(written);
        if (!simple || isBuiltinType(simple, "pascal")) continue;
        for (const name of fieldChildren(v, "name")) {
          if (name.type === "identifier") out.push({ name: name.text, type: written, line: name.startPosition.row + 1, exported });
        }
      }
    }
  };
  visit(tree.rootNode, null);
  return out;
}
