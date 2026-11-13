// A parameter that destructures one object — `({ table, onSave = noop }: { table: Table })` — is named by its
// pattern as written (`ParamInfo.name`). These helpers read the names it binds and the types its annotation
// gives them, so a body's `table.nextPage()` is typed and a `${id}` hole is a placeholder like any parameter's.
import type { Node } from "web-tree-sitter";
import type { FunctionInfo, ParamInfo } from "../../functions-classes/base.js";

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** Members of same-file object types (`interface Props { table: Table }`), by type name. */
export type ObjectTypes = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Split at top-level `sep` characters, brackets and generics nested; an arrow's `>` closes nothing. */
function splitDepth(text: string, seps: ReadonlySet<string>, generics = true): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{" || (generics && ch === "<")) depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || (generics && ch === ">" && text[i - 1] !== "=")) depth--;
    else if (depth === 0 && seps.has(ch)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** What an object pattern binds: `{ table, count: n, onSave = noop, ...rest }` → table←table, n←count, onSave←onSave. */
export function patternBindings(pattern: string): Array<{ binding: string; key: string }> {
  const text = pattern.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return [];
  const out: Array<{ binding: string; key: string }> = [];
  for (const part of splitDepth(text.slice(1, -1), new Set([","]), false)) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?(?:=[\s\S]*)?$/.exec(part);
    if (m) out.push({ binding: m[2] ?? m[1]!, key: m[1]! });
  }
  return out;
}

/** The names a parameter list binds: each parameter's own, and the ones an object pattern parameter destructures. */
export function paramNameSet(params: readonly ParamInfo[]): Set<string> {
  const names = new Set<string>();
  for (const p of params) {
    names.add(p.name);
    for (const b of patternBindings(p.name)) names.add(b.binding);
  }
  return names;
}

/** `{ table: Table; onDone?: () => void }` → key → type text, function and nested object types left out. */
export function objectTypeMembers(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = body.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return out;
  // Comments out; a union continued on the next line (`kind:\n | 'a'`) is one member.
  const flat = text
    .slice(1, -1)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .replace(/\s*\n\s*([|&])/g, " $1")
    .replace(/([|&:])[ \t]*\n\s*/g, "$1 ");
  for (const part of splitDepth(flat, new Set([";", ",", "\n"]))) {
    const m = /^\s*(?:readonly\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*\??\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (!m) continue;
    const type = m[2]!.replace(/^\|\s*/, "").replace(/\s*\|\s*(?:undefined|null)\b/g, "").trim();
    if (type && !/[=({]/.test(type)) out.set(m[1]!, type);
  }
  return out;
}

/** The file's own `interface X { … }` and `type X = { … }` declarations (an `extends` is not followed). */
export function objectTypesOf(root: Node): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const visit = (node: Node) => {
    const name = node.childForFieldName("name")?.text;
    if (node.type === "interface_declaration") {
      const body = node.childForFieldName("body");
      if (name && body) out.set(name, objectTypeMembers(body.text));
    } else if (node.type === "type_alias_declaration") {
      const value = node.childForFieldName("value");
      if (name && value?.type === "object_type") out.set(name, objectTypeMembers(value.text));
    }
  };
  for (const child of root.namedChildren) {
    if (child.type === "export_statement") {
      for (const inner of child.namedChildren) visit(inner);
    } else visit(child);
  }
  return out;
}

/**
 * The typed locals an object-pattern parameter binds: `({ table }: { table: Table })`, a renamed
 * `{ table: t }`, a defaulted `{ table = fallback }`, or `({ table }: Props)` with `Props` declared in the file.
 * A binding the body declares again is left out.
 */
export function destructuredParamTypes(params: readonly ParamInfo[], namedTypes: ObjectTypes | undefined, body: Node | null): LocalType[] {
  const out: LocalType[] = [];
  for (const p of params) {
    if (!p.name.trimStart().startsWith("{") || !p.type) continue;
    const type = p.type.trim();
    const members = type.startsWith("{") ? objectTypeMembers(type) : namedTypes?.get(type);
    if (!members || members.size === 0) continue;
    for (const { binding, key } of patternBindings(p.name)) {
      const memberType = members.get(key);
      if (!memberType || out.some((l) => l.name === binding)) continue;
      if (body && new RegExp(`\\b(?:const|let|var)\\s+${binding.replace(/\$/g, "\\$")}\\b`).test(body.text)) continue;
      out.push({ name: binding, type: memberType });
    }
  }
  return out;
}
