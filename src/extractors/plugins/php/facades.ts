import type { Node } from "web-tree-sitter";
import type { ClassInfo } from "../../../types/analysis.js";
import { simpleClassName } from "./di.js";

/**
 * A Laravel facade (`class Ledger extends Facade`) proxies its static calls to an
 * instance the container yields for `getFacadeAccessor()`: a string token
 * (`return 'ledger'`, bound by `$this->app->bind('ledger', …)`) or a class
 * (`return Ledger::class`). The plugin only states which; core resolves it
 * through the container's registrations (`ClassInfo.staticProxyOf`).
 *
 * The accessor may be `return self::TOKEN;` / `static::TOKEN` (a string or `X::class` constant of the facade) or
 * several returns that all yield the same value. When the constant is not the facade's own the accessor is
 * `staticProxyOf: { constant }` and a trait's string constants ride its `fieldValues` (`proxyConstantValues`); a
 * `static::TOKEN` declared on a trait or a parent facade is `staticProxyOf.constant`, and a class extending a
 * `*Facade` base records its constants the same way. Core reads the one value the facade's traits and facade bases
 * (up to four `extends` hops) agree on; a facade may extend such a base when it states the accessor itself. Core
 * applies the proxy only when the evidence-named class declares no such member, through the DI registrations
 * (`staticProxyLink`, `di-binding`); `config/app.php` `'aliases'` are registrations of their short name and a token
 * nothing binds links nowhere.
 */
export function facadeProxyOf(
  classNode: Node,
  extendsName: string | null,
  aliases: ReadonlyMap<string, string>,
): ClassInfo["staticProxyOf"] | undefined {
  const body = classNode.childForFieldName("body") ?? classNode.children.find((c) => c.type === "declaration_list");
  const accessor = body?.children.find((m) => m.type === "method_declaration" && m.childForFieldName("name")?.text === "getFacadeAccessor");
  // `extends Facade`, or a project's own facade base whose child states the accessor.
  if (extendsName !== "Facade" && !(accessor && extendsName)) return undefined;
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

function classConstants(classBody: Node | undefined): Node[] {
  return (classBody?.children ?? [])
    .filter((m) => m.type === "const_declaration")
    .flatMap((m) => m.namedChildren.filter((e) => e.type === "const_element"));
}

/**
 * The string constants a trait or a facade declares (`const TOKEN = 'ledger';`), by name: what a facade's
 * `static::TOKEN` reads when a trait it uses supplies the constant (`ClassInfo.fieldValues`). Only for the
 * two kinds of class a facade's accessor can borrow a constant from, so no other class's output changes.
 */
export function proxyConstantValues(classBody: Node | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const e of classConstants(classBody)) {
    const name = e.namedChildren.find((c) => c.type === "name")?.text;
    const value = proxyOfValue(e.namedChildren.filter((c) => c.type !== "name").at(-1), undefined, new Map());
    if (name && value?.token) out[name] = value.token;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
      const constant = classConstants(classBody).find((e) => e.namedChildren.find((c) => c.type === "name")?.text === parts[1]!.text);
      // Not declared here: a trait the facade uses holds it — core reads it there (a parent's is not followed).
      if (!constant) return { constant: parts[1]!.text };
      const literal = constant.namedChildren.filter((c) => c.type !== "name").at(-1);
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
