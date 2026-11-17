import type { Tree } from "web-tree-sitter";
import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";

/**
 * The class Java names a Kotlin file's top-level functions through: `<File>Kt` — the file name with its first letter
 * upper-cased and every character an identifier cannot hold turned into `_` — or what `@file:JvmName("Scoreboard")` says.
 * `@file:JvmMultifileClass` parts share that name; each part still declares its own functions.
 */
export function kotlinFacadeClass(sourceText: string, filePath: string): string | null {
  const named = !sourceText.includes("@file") ? null : /^\s*@file\s*:\s*(?:\[[^\]]*?)?\bJvmName\s*\(\s*(?:name\s*=\s*)?"([A-Za-z_$][\w$]*)"/m.exec(sourceText);
  if (named) return named[1]!;
  if (filePath.endsWith(".kts")) return null;
  const stem = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.kts?$/, "");
  if (!stem) return null;
  const ident = stem.replace(/[^A-Za-z0-9_$]/g, "_");
  return `${ident.charAt(0).toUpperCase()}${ident.slice(1)}Kt`;
}

/**
 * What Java reads a file's top-level properties through: `ClubsKt.getSeason()`, `setSeason(…)`, and `isOpen()` for a
 * Boolean named `isOpen` (its setter `setOpen`). Only what the declaration implies — a private property has no
 * accessor, a `const val`, `lateinit var` or `@JvmField` is a static field — as members marked `synthetic`, at the
 * property's line. A script (`.kts`) has no facade class, so none. A property with a receiver or a destructuring
 * pattern states no single name.
 */
export function kotlinFacadeFunctions(tree: Tree, filePath: string): FunctionInfo[] {
  if (filePath.endsWith(".kts")) return [];
  const out: FunctionInfo[] = [];
  const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const member = (name: string, params: ParamInfo[], returnType: string | null, line: number): FunctionInfo => ({
    name, params, returnType, isAsync: false, isExported: true, decorators: [], calls: [], line, endLine: line, synthetic: true,
  });
  for (const node of tree.rootNode.children) {
    if (node.type !== "property_declaration") continue;
    const modifiers = node.children.find((c) => c.type === "modifiers")?.text ?? "";
    if (/\b(?:private|const|lateinit)\b|@JvmField\b/.test(modifiers)) continue;
    if (node.children.some((c) => c.type === "receiver_type" || c.type === "multi_variable_declaration")) continue;
    const declaration = node.children.find((c) => c.type === "variable_declaration");
    const name = declaration?.children.find((c) => c.type === "simple_identifier")?.text;
    if (!declaration || !name) continue;
    const type = declaration.children.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text ?? null;
    const line = node.startPosition.row + 1;
    const flag = type === "Boolean" && /^is[A-Z]/.test(name);
    out.push(member(flag ? name : `get${capitalize(name)}`, [], type, line));
    if (node.children.find((c) => c.type === "binding_pattern_kind")?.text === "var") {
      out.push(member(`set${capitalize(flag ? name.slice(2) : name)}`, [{ name, type, defaultValue: null }], "Unit", line));
    }
  }
  return out;
}
