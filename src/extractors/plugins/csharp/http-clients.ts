import type { Node, Tree } from "web-tree-sitter";
import type { CallBaseRef, HttpClientRegistration } from "../../../types/analysis.js";
import { csharpBaseRefOf } from "./service-config.js";

/**
 * .NET HTTP clients and the base addresses they are given.
 *
 * `IHttpClientFactory` hands out clients two ways, and a registration names
 * each the way a call site reaches it:
 *   - typed: `AddHttpClient<InventoryClient>(c => c.BaseAddress = …)` — the
 *     HttpClient injected into `InventoryClient` carries that base, so the
 *     client IS the class (`AddHttpClient<IInventory, InventoryClient>`: the
 *     implementation, where the HttpClient lands);
 *     Refit's `AddRefitClient<IClubApi>()` is typed the same way, keyed by the
 *     API interface its requests are declared on (refit.ts);
 *   - named: `AddHttpClient("legacy", c => …)`, reached through
 *     `factory.CreateClient("legacy")` → `name:legacy`.
 * A class that sets its own client's base (`_http.BaseAddress = …` in its
 * constructor, `new HttpClient { BaseAddress = … }`) registers it under the
 * class name too. Only the facts are reported; core matches calls to them.
 */

const TYPE_DECL = new Set(["class_declaration", "record_declaration", "struct_declaration"]);
const STATEMENT = new Set([
  "expression_statement", "local_declaration_statement", "global_statement", "field_declaration",
  "return_statement", "arrow_expression_clause",
]);
const CODE_SCOPE = new Set([
  "method_declaration", "constructor_declaration", "local_function_statement", "property_declaration",
  "compilation_unit",
]);

function descendants(node: Node, type: string, out: Node[] = []): Node[] {
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === type) out.push(c);
    descendants(c, type, out);
  }
  return out;
}

/** `X.BaseAddress = …` and initializer `BaseAddress = …` under `node`. */
function baseAddressAssignments(node: Node): Node[] {
  return descendants(node, "assignment_expression").filter((a) => {
    const left = a.childForFieldName("left")?.text.trim() ?? "";
    return left === "BaseAddress" || left.endsWith(".BaseAddress");
  });
}

function enclosingType(node: Node): string | null {
  for (let p: Node | null = node.parent; p; p = p.parent) {
    if (TYPE_DECL.has(p.type)) return p.childForFieldName("name")?.text ?? null;
  }
  return null;
}

/** The type a client is keyed by: the last generic argument, namespace dropped. */
function typedClientKey(generic: string): string | null {
  const args = /<([^<>]+)>/.exec(generic)?.[1]?.split(",");
  const last = args?.[args.length - 1]?.trim().split(".").pop();
  return last && /^[A-Za-z_]\w*$/.test(last) ? last : null;
}

export function extractCsharpHttpClientRegistrations(tree: Tree, sourceText: string): HttpClientRegistration[] {
  const restService = sourceText.includes("RestService.For");
  if (!sourceText.includes("BaseAddress") && !restService) return [];
  const out: HttpClientRegistration[] = [];
  const claimed = new Set<number>();
  const push = (client: string, assignment: Node) => {
    claimed.add(assignment.id);
    const right = assignment.childForFieldName("right");
    const base = right ? csharpBaseRefOf(right.text) : null;
    if (base) out.push({ client, scope: "project", base, line: assignment.startPosition.row + 1 });
  };

  for (const call of descendants(tree.rootNode, "invocation_expression")) {
    const fn = call.childForFieldName("function");
    const name = fn?.type === "member_access_expression" ? fn.childForFieldName("name") : fn;
    const nameText = name?.text ?? "";
    // Refit: `RestService.For<IClubApi>("http://…")` — the generated client, given its base.
    if (restService && /^For\s*</.test(nameText) && /^RestService\b/.test(fn?.childForFieldName("expression")?.text ?? "")) {
      const key = typedClientKey(nameText);
      const first = call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type === "argument")?.text.trim();
      const base = first ? csharpBaseRefOf(first) : null;
      if (key && base) out.push({ client: key, scope: "project", base, line: call.startPosition.row + 1 });
      continue;
    }
    // A typed client — `AddHttpClient<T>`, Refit's `AddRefitClient<T>` — or a named one.
    if (!/^(?:AddHttpClient|AddRefitClient)\b/.test(nameText)) continue;
    let key = nameText.includes("<") ? typedClientKey(nameText) : null;
    if (!key) {
      const first = call.childForFieldName("arguments")?.namedChildren.find((a) => a?.type === "argument")?.text.trim();
      const lit = first ? /^"([^"]+)"$/.exec(first)?.[1] : undefined;
      if (lit) key = `name:${lit}`;
    }
    if (!key) continue;
    // The base may be set in the call's own lambda or further down its chain
    // (`.ConfigureHttpClient(c => c.BaseAddress = …)`): the whole statement.
    let stmt: Node = call;
    while (stmt.parent && !STATEMENT.has(stmt.type)) stmt = stmt.parent;
    for (const a of baseAddressAssignments(stmt)) push(key, a);
  }

  for (const a of baseAddressAssignments(tree.rootNode)) {
    if (claimed.has(a.id)) continue;
    const type = enclosingType(a);
    if (type) push(type, a);
  }
  return out;
}

/**
 * The client an HttpClient call goes through, as a registration names it: a
 * variable taken from `CreateClient("legacy")` (in the same method, or a field
 * set in the class) → `name:legacy`; otherwise the class the call sits in,
 * whose HttpClient a typed registration configures. Null outside any class
 * with no `CreateClient` to go on.
 */
export function csharpCallClient(call: Node, receiverRoot: string): CallBaseRef | null {
  const fnText = call.childForFieldName("function")?.text ?? "";
  const chained = /\.CreateClient\(\s*"([^"]+)"\s*\)/.exec(fnText);
  if (chained) return { kind: "client", key: `name:${chained[1]}` };
  if (!/^[A-Za-z_]\w*$/.test(receiverRoot)) return null;
  const created = new RegExp(`\\b${receiverRoot}\\s*=\\s*[^;]*?\\.CreateClient\\(\\s*"([^"]+)"\\s*\\)`);
  for (let p: Node | null = call.parent; p; p = p.parent) {
    if (!CODE_SCOPE.has(p.type) && !TYPE_DECL.has(p.type)) continue;
    const m = created.exec(p.text);
    if (m) return { kind: "client", key: `name:${m[1]}` };
    if (TYPE_DECL.has(p.type)) {
      const name = p.childForFieldName("name")?.text;
      return name ? { kind: "client", key: name } : null;
    }
  }
  return null;
}
