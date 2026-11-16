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

/**
 * What an object pattern binds at any depth, with the member path read to reach each: `{ a: { store }, n }` →
 * store←a.store, n←n. A rest element, a computed key and an array pattern bind nothing here.
 */
export function patternPaths(pattern: string): Array<{ binding: string; path: string[] }> {
  const text = pattern.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return [];
  const out: Array<{ binding: string; path: string[] }> = [];
  for (const part of splitDepth(text.slice(1, -1), new Set([","]), false)) {
    const head = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/.exec(part);
    if (head) {
      // The nested pattern closes at its own brace; what follows is a default (`= {}`) or nothing.
      const open = head[0].length - 1;
      const close = closingBrace(part, open);
      if (close > 0 && /^\s*(?:=[\s\S]*)?$/.test(part.slice(close + 1))) {
        for (const inner of patternPaths(part.slice(open, close + 1))) out.push({ binding: inner.binding, path: [head[1]!, ...inner.path] });
      }
      continue;
    }
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*)\s*)?(?:=[\s\S]*)?$/.exec(part);
    if (m) out.push({ binding: m[2] ?? m[1]!, path: [m[1]!] });
  }
  return out;
}

/** The names a parameter list binds: each parameter's own, and the ones an object pattern parameter destructures. */
export function paramNameSet(params: readonly ParamInfo[]): Set<string> {
  const names = new Set<string>();
  for (const p of params) {
    names.add(p.name);
    for (const b of patternPaths(p.name)) names.add(b.binding);
  }
  return names;
}

/** `{ table: Table; onDone?: () => void }` → key → type text, function and nested object types left out. */
export function objectTypeMembers(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { key, type } of typeMemberParts(body)) {
    // A nested object type is kept for a nested pattern (`{ a: { store } }`); a function type is not.
    if (type && !/[=(]/.test(type) && (!type.includes("{") || (type.startsWith("{") && type.endsWith("}")))) out.set(key, type);
  }
  return out;
}

/** Every member of an object type body as written: its key and its type text (`| undefined` / `| null` dropped). */
function typeMemberParts(body: string): Array<{ key: string; type: string }> {
  const text = body.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return [];
  // Comments out; a union continued on the next line (`kind:\n | 'a'`) is one member.
  const flat = text
    .slice(1, -1)
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .replace(/\s*\n\s*([|&])/g, " $1")
    .replace(/([|&:])[ \t]*\n\s*/g, "$1 ");
  const out: Array<{ key: string; type: string }> = [];
  for (const part of splitDepth(flat, new Set([";", ",", "\n"]))) {
    const m = /^\s*(?:readonly\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*\??\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.push({ key: m[1]!, type: m[2]!.replace(/^\|\s*/, "").replace(/\s*\|\s*(?:undefined|null)\b/g, "").trim() });
  }
  return out;
}

/**
 * Marks a type whose members are not all known here: a key of this name holds an empty string. Members the type
 * declares but whose type the reader leaves out (a function type) are held under their own key as an empty string
 * too, so a binding of one is told from a member a base or another file may declare.
 */
const OPEN = "<open>";

/** The match of a `{ … }` starting at `from` in `text`, strings skipped; -1 when it never closes. */
function closingBrace(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** An object type's readable members, plus its other declared members (a function type) as empty strings. */
function declaredMembers(body: string): Map<string, string> {
  const out = objectTypeMembers(body);
  for (const { key } of typeMemberParts(body)) if (!out.has(key)) out.set(key, "");
  return out;
}

/**
 * The file's own `interface X { … }` and `type X = { … }` declarations, with what they take from a same-file base:
 * `interface Mine extends Base` has the members of `Base` too, a `type P = Base & { n: number }` those of both.
 * A base the file does not declare (an import) adds nothing here — `destructuredParamTypes` leaves its members to
 * the linker, which reads the class that declares them.
 */
export function objectTypesOf(root: Node): Map<string, Map<string, string>> {
  const own = new Map<string, Map<string, string>>();
  const bases = new Map<string, string[]>();
  const visit = (node: Node) => {
    const name = node.childForFieldName("name")?.text;
    if (node.type === "interface_declaration") {
      const body = node.childForFieldName("body");
      if (!name || !body) return;
      own.set(name, declaredMembers(body.text));
      const list: string[] = [];
      for (const child of node.namedChildren) {
        if (child.type !== "extends_type_clause") continue;
        for (const t of child.namedChildren) {
          const base = t.type === "generic_type" ? t.childForFieldName("name")?.text : t.type === "type_identifier" ? t.text : undefined;
          if (base) list.push(base);
        }
      }
      if (list.length > 0) bases.set(name, list);
    } else if (node.type === "type_alias_declaration") {
      const value = node.childForFieldName("value");
      if (!name || !value) return;
      if (value.type === "object_type") own.set(name, declaredMembers(value.text));
      else if (value.type === "intersection_type") {
        const members = new Map<string, string>();
        const list: string[] = [];
        for (const part of splitDepth(value.text, new Set(["&"]))) {
          const t = part.trim();
          if (t.startsWith("{")) for (const [k, v] of declaredMembers(t)) members.set(k, v);
          else if (t) list.push(t);
        }
        own.set(name, members);
        if (list.length > 0) bases.set(name, list);
      }
    }
  };
  for (const child of root.namedChildren) {
    if (child.type === "export_statement") {
      for (const inner of child.namedChildren) visit(inner);
    } else visit(child);
  }
  // Members of a same-file base, the type's own winning; a cycle stops where it closes.
  const flatten = (name: string, seen: ReadonlySet<string>): Map<string, string> => {
    const merged = new Map<string, string>();
    for (const base of bases.get(name) ?? []) {
      // A base the file does not declare (an import, a utility type) may add members this reader cannot see.
      if (!own.has(base)) merged.set(OPEN, "");
      if (seen.has(base) || !own.has(base)) continue;
      for (const [k, v] of flatten(base, new Set([...seen, base]))) merged.set(k, v);
    }
    for (const [k, v] of own.get(name) ?? []) merged.set(k, v);
    return merged;
  };
  const out = new Map<string, Map<string, string>>();
  for (const name of own.keys()) out.set(name, flatten(name, new Set([name])));
  return out;
}

/** A type name that is most likely a generic parameter (`T`, `TProps`), never a class a project declares. */
const GENERIC_PARAMETER = /^[A-Z]$|^T[A-Z]\w*$/;

/** The synthetic local naming a destructured parameter as a whole, so a binding can be read off it as a member. */
const paramLocal = (index: number): string => `$param${index}`;

/**
 * The typed locals an object-pattern parameter binds: `({ table }: { table: Table })`, a renamed
 * `{ table: t }`, a defaulted `{ table = fallback }`, a nested `{ a: { table } }`, or `({ table }: Props)` with
 * `Props` declared in the file — with its same-file `extends`. A binding the annotation gives no type here (the
 * member comes from a base, or a type, declared in another file) is a member read off a local typed by the
 * annotation (`localTypes[].member`, `from: "$param0.table"`), which the linker types by the declared field of
 * that type — or leaves untyped. A binding the body declares again is left out.
 */
export function destructuredParamTypes(params: readonly ParamInfo[], namedTypes: ObjectTypes | undefined, body: Node | null): LocalType[] {
  const out: LocalType[] = [];
  params.forEach((p, index) => {
    if (!p.name.trimStart().startsWith("{") || !p.type) return;
    const type = p.type.trim();
    const named = /^[A-Za-z_$][\w$.]*$/.test(type);
    const members = type.startsWith("{") ? objectTypeMembers(type) : namedTypes?.get(type);
    let anchored = false;
    for (const { binding, path } of patternPaths(p.name)) {
      if (out.some((l) => l.name === binding)) continue;
      if (body && new RegExp(`\\b(?:const|let|var)\\s+${binding.replace(/\$/g, "\\$")}\\b`).test(body.text)) continue;
      // Walk the path through the object types the annotation states.
      let level: ReadonlyMap<string, string> | undefined = members;
      let memberType: string | undefined;
      // A nested level whose type is another file's: the rest of the path is that type's to say.
      let handedOn: { type: string; rest: string[]; depth: number } | undefined;
      for (let i = 0; i < path.length; i++) {
        memberType = level?.get(path[i]!);
        if (memberType === undefined) break;
        if (i < path.length - 1) {
          level = memberType.startsWith("{") ? objectTypeMembers(memberType) : namedTypes?.get(memberType);
          if (!level) {
            if (/^[A-Za-z_$][\w$.]*$/.test(memberType) && !GENERIC_PARAMETER.test(memberType)) handedOn = { type: memberType, rest: path.slice(i + 1), depth: i + 1 };
            memberType = undefined;
            break;
          }
        }
      }
      if (handedOn) {
        const local = `${paramLocal(index)}_${path.slice(0, handedOn.depth).join("_")}`;
        if (!out.some((l) => l.name === local)) out.push({ name: local, type: handedOn.type });
        out.push({ name: binding, type: "", from: `${local}.${handedOn.rest.join(".")}`, member: true });
        continue;
      }
      if (memberType) {
        if (!memberType.startsWith("{")) out.push({ name: binding, type: memberType });
        // An empty type is a member the type declares and this reader leaves untyped (a function type): nothing to say.
      } else if (named && path.length === 1 && memberType === undefined && !GENERIC_PARAMETER.test(type) && (!members || members.has(OPEN))) {
        // From a base or another file: a member of the annotated type, typed by its declaration where the linker can read it.
        if (!anchored) {
          out.push({ name: paramLocal(index), type });
          anchored = true;
        }
        out.push({ name: binding, type: "", from: `${paramLocal(index)}.${path[0]}`, member: true });
      }
    }
  });
  return out;
}
