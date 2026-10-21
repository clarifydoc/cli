import type { Node, Tree } from "web-tree-sitter";
import type { DomBinding } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/** Cheap gate: the file binds a listener somewhere. */
const GATE = /addEventListener|\.on\s*\(|\.(?:click|submit|change)\s*\(|\.on(?:click|submit|change|input)\s*=/;

/** jQuery's shorthand binders: `$("#save").click(save)`. */
const SHORTHAND = new Set(["click", "submit", "change", "dblclick", "keyup", "keydown", "input", "focus", "blur"]);

/**
 * A classic page script's listeners, by the selector of the elements they are
 * bound to — what ties a server-rendered page's buttons to the functions they run:
 *
 *   document.getElementById("save-club").addEventListener("click", saveClub);   // #save-club
 *   document.querySelectorAll("button[data-delete]").forEach((btn) => {
 *       btn.addEventListener("click", deleteClub);                               // button[data-delete]
 *   });
 *   $("#transfer-form").on("submit", submitTransfer);                            // #transfer-form
 *   $(document).on("click", ".release-player", releasePlayer);                   // .release-player (delegated)
 *   document.querySelector(".kick-off").onclick = () => startMatch();            // .kick-off, inline
 *
 * The receiver resolves through a lookup call (`getElementById`, `querySelector(All)`,
 * `$`/`jQuery`), a `forEach` parameter over one, or a `const` initialized by one.
 * A named handler is reported by name; an inline one as null (its calls belong
 * to the enclosing function, which the resolver takes instead).
 */
export function extractDomBindings(tree: Tree, sourceText: string): DomBinding[] {
  if (!GATE.test(sourceText)) return [];
  const consts = new Map<string, string | null>();
  for (const d of tree.rootNode.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name");
    const value = d?.childForFieldName("value");
    if (name?.type !== "identifier" || !value) continue;
    const sel = lookupSelector(value);
    if (sel === undefined) continue;
    // A name bound twice to different lookups says nothing.
    consts.set(name.text, consts.has(name.text) && consts.get(name.text) !== sel ? null : sel);
  }

  const out: DomBinding[] = [];
  const push = (recv: Node | null, event: string, handler: Node | undefined, line: number, delegated?: string) => {
    const selector = delegated ?? (recv ? receiverSelector(recv, consts) : null);
    if (!selector || !handler) return;
    out.push({ selector, event: event.toLowerCase(), handler: handlerName(handler), line });
  };
  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_expression") continue;
    const prop = fn.childForFieldName("property")?.text ?? "";
    const recv = fn.childForFieldName("object");
    const args = call.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
    const line = call.startPosition.row + 1;
    if (prop === "addEventListener" || prop === "on") {
      const event = args[0]?.type === "string" ? stripQuotes(args[0].text) : null;
      if (!event) continue;
      // `.on("click", ".child", handler)`: delegated to the child selector.
      const delegated = prop === "on" && args[1]?.type === "string" ? stripQuotes(args[1].text) : undefined;
      push(recv, event.split(/[\s.]/)[0]!, args[delegated !== undefined ? 2 : 1], line, delegated);
    } else if (SHORTHAND.has(prop) && args.length === 1) {
      push(recv, prop, args[0], line);
    }
  }
  // `el.onclick = handler`
  for (const asg of tree.rootNode.descendantsOfType("assignment_expression")) {
    const left = asg?.childForFieldName("left");
    if (!asg || left?.type !== "member_expression") continue;
    const prop = left.childForFieldName("property")?.text ?? "";
    if (!/^on[a-z]+$/.test(prop)) continue;
    push(left.childForFieldName("object"), prop.slice(2), asg.childForFieldName("right") ?? undefined, asg.startPosition.row + 1);
  }
  return out;
}

/** The selector a lookup expression selects; undefined when it is no lookup. */
function lookupSelector(node: Node): string | undefined {
  if (node.type === "await_expression" || node.type === "parenthesized_expression") return node.namedChildren[0] ? lookupSelector(node.namedChildren[0]) : undefined;
  if (node.type !== "call_expression") return undefined;
  const fn = node.childForFieldName("function");
  const arg = node.childForFieldName("arguments")?.namedChildren[0];
  const literal = arg?.type === "string" ? stripQuotes(arg.text) : null;
  if (fn?.type === "identifier" && (fn.text === "$" || fn.text === "jQuery")) return literal ?? undefined;
  if (fn?.type !== "member_expression") return undefined;
  const prop = fn.childForFieldName("property")?.text;
  if (!literal) return undefined;
  if (prop === "getElementById") return `#${literal}`;
  if (prop === "getElementsByClassName") return `.${literal}`;
  if (prop === "querySelector" || prop === "querySelectorAll") return literal;
  return undefined;
}

/** The selector the elements a receiver stands for match, or null. */
function receiverSelector(recv: Node, consts: Map<string, string | null>): string | null {
  const direct = lookupSelector(recv);
  if (direct !== undefined) return direct;
  if (recv.type !== "identifier") return null;
  // `document.querySelectorAll(sel).forEach((btn) => btn.addEventListener(…))`
  for (let p: Node | null = recv.parent; p; p = p.parent) {
    if (p.type !== "arrow_function" && p.type !== "function_expression" && p.type !== "function") continue;
    const params = p.childForFieldName("parameters") ?? p.childForFieldName("parameter");
    const first = params?.type === "identifier" ? params : params?.namedChildren[0];
    if (first?.text !== recv.text) continue;
    const call = p.parent?.parent;
    const fn = call?.type === "call_expression" ? call.childForFieldName("function") : null;
    if (fn?.type !== "member_expression" || !/^(?:forEach|each|map)$/.test(fn.childForFieldName("property")?.text ?? "")) return null;
    const over = fn.childForFieldName("object");
    return over ? (lookupSelector(over) ?? null) : null;
  }
  return consts.get(recv.text) ?? null;
}

/** A named handler's name (`deleteClub`, `this.save` → save); null for an inline function. */
function handlerName(node: Node): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "member_expression") return node.childForFieldName("property")?.text ?? null;
  return null;
}
