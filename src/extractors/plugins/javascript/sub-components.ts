import type { Node, Tree } from "web-tree-sitter";
import type {
  SubComponentInfo,
  ImportInfo,
  Language,
} from "../../../types/analysis.js";

/**
 * Extract sub-component usage from JSX/TSX files.
 * Looks for <ComponentName> usage in JSX elements.
 */
export function extractSubComponents(
  tree: Tree,
  sourceText: string,
  language: Language,
  imports: ImportInfo[],
): SubComponentInfo[] {
  if (language !== "typescript" && language !== "javascript") return [];

  const components: SubComponentInfo[] = [];
  const seen = new Set<string>();
  const importMap = buildImportMap(imports);

  walkForJsx(tree.rootNode, components, seen, importMap);
  if (/\.component\s*\(/.test(sourceText)) components.push(...globalRegistrations(tree, importMap));
  return components;
}

/**
 * `app.component("ClubCard", ClubCard)` / `Vue.component("club-card", ClubCard)`: an imported component registered for
 * every template. Also a registration loop over an object of components under a literal prefix —
 * `Object.keys(kit).forEach((k) => Vue.component(`club${k}`, kit[k]))`, `Vue.component(`club${keys[i]}`, this[keys[i]])`
 * inside the object's own `install`, `for (const [k, v] of Object.entries(kit)) app.component(`club${k}`, v)`: each of the
 * object's keys whose value is an imported component, under prefix + key (`clubDeleteModal`, which Vue serves as
 * `<club-delete-modal>` and `<ClubDeleteModal>`). A prefix that is not literal registers nothing.
 */
function globalRegistrations(tree: Tree, importMap: Map<string, string>): SubComponentInfo[] {
  const out: SubComponentInfo[] = [];
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (fn?.type !== "member_expression" || fn.childForFieldName("property")?.text !== "component") continue;
    const [nameArg, valueArg] = call!.childForFieldName("arguments")?.namedChildren ?? [];
    const line = call!.startPosition.row + 1;
    if (nameArg?.type === "string") {
      const source = valueArg?.type === "identifier" ? importMap.get(valueArg.text) : undefined;
      if (source) out.push({ name: nameArg.text.slice(1, -1), importSource: source, props: [], line, global: true });
      continue;
    }
    const named = nameArg ? registeredName(nameArg) : null;
    const object = named && valueArg ? registeredObject(valueArg, named.key) : null;
    if (!named || !object) continue;
    for (const [key, local] of componentEntries(object)) {
      const source = importMap.get(local);
      if (source) out.push({ name: named.prefix + key, importSource: source, props: [], line, global: true });
    }
  }
  return out;
}

/** The name a loop registers: `` `club${key}` `` → prefix `club` + the key expression; a bare `key` has no prefix. */
function registeredName(node: Node): { prefix: string; key: string } | null {
  if (node.type === "identifier") return { prefix: "", key: node.text };
  if (node.type !== "template_string") return null;
  const parts = node.namedChildren.filter((c): c is Node => !!c);
  const last = parts[parts.length - 1];
  // The prefix is every part before the one substitution, which ends the name: literal text only.
  if (last?.type !== "template_substitution" || parts.slice(0, -1).some((p) => p.type !== "string_fragment")) return null;
  const key = last.namedChildren[0];
  return key ? { prefix: parts.slice(0, -1).map((p) => p.text).join(""), key: key.text } : null;
}

/**
 * The object a registration's value is read from by the same key the name is built from: `kit[key]` / `this[key]`,
 * or `v` destructured beside `key` from `Object.entries(kit)` (`([key, v]) => …`, `for (const [key, v] of …)`).
 */
function registeredObject(value: Node, key: string): Node | null {
  if (value.type === "subscript_expression") {
    if (value.childForFieldName("index")?.text !== key) return null;
    return objectOf(value.childForFieldName("object"), value);
  }
  if (value.type !== "identifier") return null;
  for (let n: Node | null = value.parent; n; n = n.parent) {
    let pattern: Node | null | undefined;
    let entries: Node | null | undefined;
    if (n.type === "for_in_statement") {
      pattern = n.childForFieldName("left");
      entries = n.childForFieldName("right");
    } else if (n.type === "arrow_function" || n.type === "function_expression") {
      const params = n.childForFieldName("parameters");
      pattern = params?.namedChildren[0] ?? n.childForFieldName("parameter");
      // `Object.entries(kit).forEach(([key, v]) => …)`: the callback's receiver.
      const call = n.parent?.parent;
      const callee = call?.type === "call_expression" ? call.childForFieldName("function") : null;
      entries = callee?.type === "member_expression" && callee.childForFieldName("property")?.text === "forEach" ? callee.childForFieldName("object") : null;
    } else continue;
    if (pattern?.type !== "array_pattern") continue;
    const [k, v] = pattern.namedChildren;
    if (k?.text !== key || v?.text !== value.text) continue;
    if (entries?.type !== "call_expression" || entries.childForFieldName("function")?.text !== "Object.entries") return null;
    return objectOf(entries.childForFieldName("arguments")?.namedChildren[0] ?? null, value);
  }
  return null;
}

/**
 * The object literal an expression names: `this` inside one of its methods (`install(Vue) { … }`), or a local the file
 * declares once as an object literal (`const kit = { DeleteModal, KitButton }`).
 */
function objectOf(expr: Node | null, at: Node): Node | null {
  if (expr?.type === "this") {
    for (let n: Node | null = at.parent; n; n = n.parent) {
      if (n.type === "arrow_function") continue;
      if (n.type === "method_definition") return n.parent?.type === "object" ? n.parent : null;
      if (n.type === "function_expression" || n.type === "function") return n.parent?.type === "pair" && n.parent.parent?.type === "object" ? n.parent.parent : null;
      if (n.type === "function_declaration" || n.type === "generator_function_declaration" || n.type === "class_body") return null;
    }
    return null;
  }
  if (expr?.type !== "identifier") return null;
  const objects = at.tree.rootNode
    .descendantsOfType("variable_declarator")
    .filter((d) => d?.childForFieldName("name")?.text === expr.text)
    .map((d) => d!.childForFieldName("value"));
  return objects.length === 1 && objects[0]?.type === "object" ? objects[0] : null;
}

/** An object literal's component entries: key → the local its value names (`DeleteModal`, `Button: KitButton`). */
function componentEntries(object: Node): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const prop of object.namedChildren) {
    if (prop?.type === "shorthand_property_identifier") out.push([prop.text, prop.text]);
    else if (prop?.type === "pair") {
      const k = prop.childForFieldName("key");
      const v = prop.childForFieldName("value");
      const key = k?.type === "property_identifier" ? k.text : k?.type === "string" ? k.text.slice(1, -1) : null;
      if (key && v?.type === "identifier") out.push([key, v.text]);
    }
  }
  return out;
}

function walkForJsx(
  node: Node,
  components: SubComponentInfo[],
  seen: Set<string>,
  importMap: Map<string, string>,
) {
  if (
    node.type === "jsx_opening_element" ||
    node.type === "jsx_self_closing_element"
  ) {
    const nameNode = node.childForFieldName("name") ?? node.child(1);
    if (nameNode) {
      const name = nameNode.text;
      // Components start with uppercase (not HTML elements)
      if (name && /^[A-Z]/.test(name) && !seen.has(name)) {
        seen.add(name);
        const props = extractJsxProps(node);
        components.push({
          name,
          importSource: importMap.get(name) ?? null,
          props,
          line: node.startPosition.row + 1,
        });
      }
      // `<CarForm ref={formRef} />`: the parent reaches the child's handle as `formRef.current`.
      const ref = name && /^[A-Z]/.test(name) ? jsxRef(node) : null;
      const sub = ref ? components.find((c) => c.name === name && !c.global) : undefined;
      if (sub && ref) sub.refs = [...new Set([...(sub.refs ?? []), ref])];
    }
  }

  for (const child of node.children) {
    walkForJsx(child, components, seen, importMap);
  }
}

/** The ref a JSX tag binds, when it is a variable or a field: `ref={formRef}`, `ref={this.formRef}`. */
function jsxRef(node: Node): string | null {
  for (const child of node.children) {
    if (child.type !== "jsx_attribute" || !child.text.startsWith("ref")) continue;
    const m = /^ref\s*=\s*\{\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*\}$/.exec(child.text);
    if (m) return m[1]!;
  }
  return null;
}

export function extractJsxProps(node: Node): string[] {
  const props: string[] = [];
  for (const child of node.children) {
    if (child.type === "jsx_attribute") {
      const name = child.childForFieldName("name")?.text ?? child.child(0)?.text;
      if (name) props.push(name);
    } else if (child.type === "jsx_expression" && child.text.includes("...")) {
      props.push("...spread");
    }
  }
  return props;
}

function buildImportMap(imports: ImportInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of imports) {
    for (const spec of imp.specifiers) {
      map.set(spec, imp.source);
    }
  }
  return map;
}
