import type { Node } from "web-tree-sitter";
import { boundByParameterAt, moduleBindingAt } from "./block-scope.js";
import { dispatchMapEntries } from "./dispatch-maps.js";
import { heldFunction } from "./held-functions.js";
import { FUNCTION_EXPRESSIONS, wrappedFunction } from "./wrapped-functions.js";

/**
 * Function values a module's objects hold under a member, as `passed: "property"` records the linker's
 * dispatch-map join reads (`CallInfo.returnedAs` = the holder and member):
 *
 *   - a member assigned at run time, `dialog.callback = deleteClubs` — `deleteClubs` under `dialog.callback`, a
 *     written callback (`toast.action = () => reload()`) by its held function's name, and every value of a
 *     dispatch map the file declares for a lookup in one (`dialog.callback = callbacks[mode]`);
 *   - the objects of a declared array, `const items = [{ run: sellPlayer }]` — `sellPlayer` under `items[].run`.
 *
 * A holder the site binds itself (a parameter, a local) is another object each time: only the module's own
 * objects are recorded. The class a field is assigned (`this.editClubDialog = ClubEditDialog`) is recorded
 * under `this.editClubDialog`, for the dialog a field opens.
 */

/** A plain or dotted name (`saveClub`, `this.remove`), never an `undefined`/`null`-like literal. */
const NAMED_VALUE = /^(?!undefined$|null$|true$|false$)[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** Keys of a declared array's objects that hold a lazily loaded module or a nested route, never a callback. */
const NOT_CALLBACK_KEYS: ReadonlySet<string> = new Set(["component", "components", "loader", "lazy", "loadChildren", "loadComponent", "children", "redirect", "redirectTo", "resolve", "canActivate", "canDeactivate", "beforeEnter"]);
const WRAPPERS: ReadonlySet<string> = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"]);

export interface MemberValue {
  name: string;
  node: Node;
  holder: string;
}

/** The function values an assignment puts under a module object's member. */
export function memberAssignment(node: Node): MemberValue[] {
  const left = node.childForFieldName("left");
  let right = node.childForFieldName("right");
  while (right && WRAPPERS.has(right.type)) right = right.namedChild(0);
  if (left?.type !== "member_expression" || !right) return [];
  const object = left.childForFieldName("object");
  const member = left.childForFieldName("property");
  if (member?.type !== "property_identifier" || (object?.type !== "identifier" && object?.type !== "this")) return [];
  const holder = `${object.text}.${member.text}`;
  // A field assigned a class: the dialog a field opens (`this.editClubDialog = ClubEditDialog`).
  if (object.type === "this") return right.type === "identifier" && /^[A-Z]/.test(right.text) ? [{ name: right.text, node: right, holder }] : [];
  if (!moduleBindingAt(node, object.text)) return [];
  const held = heldFunction(right);
  if (held) return [{ name: held, node: right, holder }];
  if ((right.type === "identifier" && namesFunction(node, right.text)) || (right.type === "member_expression" && NAMED_VALUE.test(right.text))) {
    return [{ name: right.text, node: right, holder }];
  }
  // `callbacks[mode]`: whichever function the dispatch map holds.
  if (right.type === "subscript_expression") {
    const map = right.childForFieldName("object");
    const declarator = map?.type === "identifier" ? mapDeclarator(node, map.text) : null;
    const entries = declarator ? dispatchMapEntries(declarator)?.entries ?? [] : [];
    // At the lookup's own site: the map's values are already recorded at theirs, under the map's keys.
    return entries.map((e) => ({ name: e.value.text, node: right, holder }));
  }
  return [];
}

/**
 * Whether a name handed to a member can be a function: one the file declares as a function, a function written
 * in place or wrapped (`const save = useCallback(…)`), or a name it does not bind (an import). A local or module
 * value bound to anything else (`const draft = loadDraft()`, a construction) and a parameter are data.
 */
export function namesFunction(site: Node, name: string): boolean {
  if (!NAMED_VALUE.test(name)) return false;
  const declared = mapDeclarator(site, name);
  if (declared) {
    let value = declared.childForFieldName("value");
    while (value && WRAPPERS.has(value.type)) value = value.namedChild(0);
    return !!value && (FUNCTION_EXPRESSIONS.has(value.type) || wrappedFunction(value) !== null);
  }
  return !boundByParameterAt(site, name);
}

/** Whether the file declares `name` a function where the site sees it: `function sellPlayer()`, `const sellPlayer = () => …`. */
function declaresFunction(site: Node, name: string): boolean {
  if (mapDeclarator(site, name)) return namesFunction(site, name);
  for (let p = site.parent; p; p = p.parent) {
    if (p.type !== "statement_block" && p.type !== "program") continue;
    for (const stmt of p.namedChildren) {
      const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
      if ((decl?.type === "function_declaration" || decl?.type === "generator_function_declaration") && decl.childForFieldName("name")?.text === name) return true;
    }
  }
  return false;
}

/** The `const`/`let`/`var` declaring `name` that the site sees: in an enclosing function body, else at the top level. */
function mapDeclarator(site: Node, name: string): Node | null {
  for (let p = site.parent; p; p = p.parent) {
    if (p.type !== "statement_block" && p.type !== "program") continue;
    for (const stmt of p.namedChildren) {
      const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
      if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
      for (const d of decl.namedChildren) if (d.type === "variable_declarator" && d.childForFieldName("name")?.text === name) return d;
    }
  }
  return null;
}

/** The function values the objects of a declared array hold, by key: `const items = [{ run: sellPlayer }, { run: () => … }]`. */
export function arrayMapEntries(declarator: Node): { holder: string; entries: Array<{ name: string; node: Node; key: string }> } | null {
  const name = declarator.childForFieldName("name");
  let value = declarator.childForFieldName("value");
  if (name?.type !== "identifier" || !value) return null;
  // `ref([…])`, `computed(() => […])` — a function returning the array (`const items = () => […]`) is a function.
  let wrapped = false;
  for (let hop = 0; hop < 3 && value; hop++) {
    while (value && WRAPPERS.has(value.type)) value = value.namedChild(0);
    if (value?.type === "call_expression" && value.childForFieldName("function")?.type === "identifier") {
      value = value.childForFieldName("arguments")?.namedChildren.find((a) => a?.type !== "comment") ?? null;
      wrapped = true;
    } else if (value?.type === "arrow_function" && wrapped) value = value.childForFieldName("body");
    else break;
  }
  if (value?.type !== "array") return null;
  const entries: Array<{ name: string; node: Node; key: string }> = [];
  for (const element of value.namedChildren) {
    if (element?.type !== "object") continue;
    for (const member of element.namedChildren) {
      if (member?.type === "shorthand_property_identifier") {
        if (/^[a-z_$]/.test(member.text) && !NOT_CALLBACK_KEYS.has(member.text) && declaresFunction(member, member.text)) entries.push({ name: member.text, node: member, key: member.text });
        continue;
      }
      if (member?.type !== "pair") continue;
      const key = member.childForFieldName("key");
      let held = member.childForFieldName("value");
      while (held && WRAPPERS.has(held.type)) held = held.namedChild(0);
      const keyText = key?.type === "property_identifier" ? key.text : key?.type === "string" ? key.text.slice(1, -1) : "";
      if (!held || !/^[A-Za-z_$][\w$]*$/.test(keyText) || NOT_CALLBACK_KEYS.has(keyText)) continue;
      const fn = heldFunction(held);
      if (fn) entries.push({ name: fn, node: held, key: keyText });
      // A function is named lower-case (`sellPlayer`, `this.remove`); a capitalized value is a component or a constant.
      else if (((held.type === "identifier" && declaresFunction(held, held.text)) || (held.type === "member_expression" && held.text.startsWith("this."))) && NAMED_VALUE.test(held.text) && /^[a-z_$]/.test(held.text.split(".").pop()!) && !/^(?:this\.)?\$?t$/.test(held.text)) {
        entries.push({ name: held.text, node: held, key: keyText });
      }
    }
  }
  return entries.length > 0 ? { holder: name.text, entries } : null;
}
