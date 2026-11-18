import type { Node, Tree } from "web-tree-sitter";
import { isFunctionBinding, stringValue } from "./syntax.js";

/**
 * A module's string `let`s → `FileAnalysis.moduleValues`: top-level
 * `let clubs = "/api/clubs"` as `clubs`, and a nested
 * `module Paths = struct let garages = "/api/garages" end` as
 * `Paths.garages`. A value bound twice with different text is left out.
 * Dream `:id` placeholders are written as `{id}` so a route that takes the
 * constant joins callers the same way a literal path does. The file module's
 * bare names are re-keyed as `Paths.clubs` in `postExtract` once the file is
 * renamed to its stem (`paths.ml` → `Paths`).
 */
export function extractOcamlModuleValues(tree: Tree): Record<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  const put = (key: string, value: string) => {
    if (out.has(key) && out.get(key) !== value) clash.add(key);
    else out.set(key, value);
  };
  const read = (body: Node, prefix: string): void => {
    for (const child of body.namedChildren) {
      if (child.type === "module_definition") {
        for (const binding of child.namedChildren.filter((c) => c.type === "module_binding")) {
          const name = binding.namedChildren.find((c) => c.type === "module_name")?.text;
          const inner = binding.childForFieldName("body");
          if (name && inner?.type === "structure") read(inner, `${prefix}${name}.`);
        }
        continue;
      }
      if (child.type !== "value_definition") continue;
      for (const binding of child.namedChildren.filter((c) => c.type === "let_binding")) {
        if (isFunctionBinding(binding)) continue;
        const name = binding.childForFieldName("pattern")?.type === "value_name"
          ? binding.childForFieldName("pattern")!.text
          : null;
        const raw = stringValue(binding.childForFieldName("body"));
        if (!name || raw === null) continue;
        put(prefix + name, raw.startsWith("/") ? raw.replace(/:(\w+)/g, "{$1}") : raw);
      }
    }
  };
  read(tree.rootNode, "");
  for (const k of clash) out.delete(k);
  return Object.fromEntries(out);
}
