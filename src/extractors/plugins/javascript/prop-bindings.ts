import type { Node, Tree } from "web-tree-sitter";
import type { PropBinding } from "../../../types/analysis.js";
import { expressionOrigin, templateValueOrigin } from "./arg-origins.js";

/**
 * Values a component's markup binds to its children's props, where the value's
 * origin is known (`FileAnalysis.propBindings`): JSX `<ClubCard clubId={id} />`
 * and a Vue template's `<ClubCard :club-id="clubId" />`. The `paramOrigins`
 * pass follows a child's `props.clubId` up through them to a route parameter.
 */
export function propBindings(tree: Tree, sourceText: string, rawSource: string, filePath: string): PropBinding[] {
  if (filePath.endsWith(".vue")) return vueBindings(tree, rawSource);
  if (!/<[A-Z][\w.]*[\s/>]/.test(sourceText)) return [];
  const out: PropBinding[] = [];
  const visit = (n: Node): void => {
    if (n.type === "jsx_opening_element" || n.type === "jsx_self_closing_element") {
      const tag = n.childForFieldName("name")?.text ?? "";
      if (/^[A-Z]/.test(tag)) {
        for (const attr of n.namedChildren) {
          if (attr?.type !== "jsx_attribute") continue;
          const name = attr.namedChild(0);
          const value = attr.namedChild(1);
          if (name?.type !== "property_identifier" || value?.type !== "jsx_expression") continue;
          const expr = value.namedChild(0);
          const found = expr ? expressionOrigin(expr) : null;
          if (!found || found.origin.kind === "literal") continue;
          out.push({ component: tag, prop: name.text, line: attr.startPosition.row + 1, origin: found.origin, ...(found.transform ? { transform: found.transform } : {}) });
        }
      }
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  visit(tree.rootNode);
  return out;
}

/** `:club-id="clubId"` / `v-bind:club-id="…"` on a component tag (PascalCase or kebab-case with a hyphen). */
function vueBindings(tree: Tree, raw: string): PropBinding[] {
  const start = raw.search(/<template\b/i);
  const end = raw.lastIndexOf("</template>");
  if (start < 0 || end < start || !/(?:^|\s)(?::|v-bind:)[\w-]+\s*=/.test(raw.slice(start, end))) return [];
  const anchor = tree.rootNode.namedChildren.find((c) => !!c && c.type !== "comment") ?? null;
  if (!anchor) return [];
  const declared = declaredProps(tree.rootNode);
  const out: PropBinding[] = [];
  const template = raw.slice(start, end);
  const lineAt = (offset: number) => raw.slice(0, start + offset).split("\n").length;
  for (const tag of template.matchAll(/<([A-Z][\w]*|[a-z][\w]*-[\w-]*)(?=[\s/>])/g)) {
    const attrs = attributesAfter(template, tag.index! + tag[0].length);
    for (const a of attrs) {
      const bound = /^(?::|v-bind:)([\w-]+)$/.exec(a.name);
      if (!bound) continue;
      const prop = bound[1]!.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
      if (prop === "key" || prop === "ref" || prop === "class" || prop === "style" || prop === "is") continue;
      const value = a.value.trim();
      const wrapped = /^(Number|String|parseInt|encodeURIComponent)\(\s*(.*?)\s*\)$/.exec(value);
      const chain = wrapped ? wrapped[2]! : value;
      if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(chain)) continue;
      const origin = templateValueOrigin(anchor, chain.split("."), declared);
      if (!origin || origin.kind === "literal") continue;
      out.push({ component: tag[1]!, prop, line: lineAt(a.offset), origin, ...(wrapped ? { transform: wrapped[1]! } : {}) });
    }
  }
  return out;
}

/** The attributes of a tag from `from` to its `>`, quoted values kept whole. */
function attributesAfter(text: string, from: number): Array<{ name: string; value: string; offset: number }> {
  const out: Array<{ name: string; value: string; offset: number }> = [];
  const re = /\s*([^\s=/>"']+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?|\s*\/?>/gy;
  re.lastIndex = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[1]) break;
    if (m[2] !== undefined) out.push({ name: m[1], value: m[3] ?? m[4] ?? "", offset: m.index });
  }
  return out;
}

/** The props a Vue component declares: `defineProps<{ a: T }>()` (or a named type), `defineProps({ a: … })`, `['a']`, an options `props:`. */
function declaredProps(root: Node): Set<string> {
  const out = new Set<string>();
  const typeMembers = (t: Node | null): void => {
    if (!t) return;
    if (t.type === "object_type" || t.type === "interface_body") {
      for (const m of t.namedChildren) if (m?.type === "property_signature") out.add(m.childForFieldName("name")?.text ?? "");
      return;
    }
    if (t.type === "type_identifier") {
      for (const d of root.descendantsOfType(["interface_declaration", "type_alias_declaration"])) {
        if (d?.childForFieldName("name")?.text !== t.text) continue;
        typeMembers(d.type === "interface_declaration" ? d.childForFieldName("body") : d.childForFieldName("value"));
      }
    }
  };
  const valueMembers = (v: Node | null | undefined): void => {
    if (v?.type === "object") {
      for (const p of v.namedChildren) {
        if (p?.type === "pair") out.add(p.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "") ?? "");
        else if (p?.type === "shorthand_property_identifier") out.add(p.text);
      }
    } else if (v?.type === "array") {
      for (const e of v.namedChildren) if (e?.type === "string") out.add(e.text.slice(1, -1));
    }
  };
  for (const call of root.descendantsOfType("call_expression")) {
    if (call?.childForFieldName("function")?.text !== "defineProps") continue;
    const typeArg = call.childForFieldName("type_arguments")?.namedChild(0) ?? null;
    typeMembers(typeArg);
    valueMembers(call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment"));
  }
  for (const pair of root.descendantsOfType("pair")) {
    if (pair?.childForFieldName("key")?.text !== "props" || pair.parent?.parent?.type === "pair") continue;
    valueMembers(pair.childForFieldName("value"));
  }
  out.delete("");
  return out;
}
