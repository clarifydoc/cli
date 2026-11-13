import type { Node } from "web-tree-sitter";
import type { ClassInfo } from "../../../types/analysis.js";
import { simpleClassName } from "./di.js";

/**
 * A Laravel facade (`class Ledger extends Facade`) proxies its static calls to an
 * instance the container yields for `getFacadeAccessor()`: a string token
 * (`return 'ledger'`, bound by `$this->app->bind('ledger', …)`) or a class
 * (`return Ledger::class`). The plugin only states which; core resolves it
 * through the container's registrations (`ClassInfo.staticProxyOf`).
 */
export function facadeProxyOf(
  classNode: Node,
  extendsName: string | null,
  aliases: ReadonlyMap<string, string>,
): ClassInfo["staticProxyOf"] | undefined {
  if (extendsName !== "Facade") return undefined;
  const body = classNode.childForFieldName("body") ?? classNode.children.find((c) => c.type === "declaration_list");
  const accessor = body?.children.find((m) => m.type === "method_declaration" && m.childForFieldName("name")?.text === "getFacadeAccessor");
  const fnBody = accessor?.childForFieldName("body");
  if (!fnBody) return undefined;
  const returns: Node[] = [];
  const walk = (n: Node): void => {
    if (n.type === "return_statement") { returns.push(n); return; }
    if (n.type === "anonymous_function" || n.type === "arrow_function") return;
    for (const c of n.children) walk(c);
  };
  walk(fnBody);
  if (returns.length === 0) return undefined;
  // Every `return` must say the same: one branch per environment, one answer.
  const answers = returns.map((r) => proxyOfValue(r.namedChildren[0], body, aliases));
  const first = answers[0];
  return first && answers.every((a) => a && a.type === first.type && a.token === first.token) ? first : undefined;
}

function proxyOfValue(value: Node | undefined, classBody: Node | undefined, aliases: ReadonlyMap<string, string>): ClassInfo["staticProxyOf"] | undefined {
  if (!value) return undefined;
  if (value.type === "class_constant_access_expression") {
    const parts = value.namedChildren;
    if (parts.length !== 2) return undefined;
    const holder = parts[0]!.text;
    if (parts[1]!.text !== "class") {
      // `return self::TOKEN;` — the class constant of this very class.
      if (holder !== "self" && holder !== "static") return undefined;
      const constant = classBody?.children
        .filter((m) => m.type === "const_declaration")
        .flatMap((m) => m.namedChildren.filter((e) => e.type === "const_element"))
        .find((e) => e.namedChildren.find((c) => c.type === "name")?.text === parts[1]!.text);
      const literal = constant?.namedChildren.filter((c) => c.type !== "name").at(-1);
      return literal && literal.type !== "class_constant_access_expression" ? proxyOfValue(literal, undefined, aliases) : undefined;
    }
    const raw = simpleClassName(holder);
    return raw && raw !== "static" && raw !== "self" ? { type: aliases.get(raw) ?? raw } : undefined;
  }
  if (value.type === "string" || value.type === "encapsed_string") {
    // Interpolation makes the token a computed value, not a name.
    if (value.namedChildren.some((c) => c.type !== "string_content" && c.type !== "string_value")) return undefined;
    const text = (value.children.find((c) => c.type === "string_content" || c.type === "string_value")?.text ?? "").trim();
    return text && !/[$\s]/.test(text) ? { token: text } : undefined;
  }
  return undefined;
}
