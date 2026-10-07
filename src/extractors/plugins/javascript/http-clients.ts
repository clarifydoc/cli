import type { Node, Tree } from "web-tree-sitter";

/**
 * HTTP client instances a file creates with a base URL —
 *   const apiClient = axios.create({ baseURL: import.meta.env.VITE_API_URL || "/api" })
 *   const api = ky.create({ prefixUrl: "https://host/v1" })   (also `.extend`)
 * → `{ apiClient: "/api", api: "/v1" }` (`FileAnalysis.httpClientBases`).
 *
 * Only what the source states: a string literal, or the literal fallback of
 * `env || "…"` / `env ?? "…"` (the dev default the app runs with when the
 * variable is unset). A base built any other way is unknown and recorded
 * nothing — guessing it would move every call through the client.
 */
const CLIENT_FACTORY_RE = /\b(?:axios|ky|got)\.(?:create|extend)\s*\(/;

export function extractHttpClientBases(tree: Tree, sourceText: string): Record<string, string> {
  if (!CLIENT_FACTORY_RE.test(sourceText)) return {};
  const out: Record<string, string> = {};
  for (const decl of tree.rootNode.descendantsOfType("variable_declarator")) {
    const name = decl.childForFieldName("name");
    const value = decl.childForFieldName("value");
    if (name?.type !== "identifier" || value?.type !== "call_expression") continue;
    const fn = value.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "";
    if (!/^(?:axios|ky|got)\.(?:create|extend)$/.test(fn)) continue;
    const config = value.childForFieldName("arguments")?.namedChildren[0];
    if (config?.type !== "object") continue;
    for (const pair of config.namedChildren) {
      if (pair.type !== "pair") continue;
      const key = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
      if (key !== "baseURL" && key !== "prefixUrl" && key !== "prefixURL") continue;
      const base = basePath(pair.childForFieldName("value"));
      if (base !== null) out[name.text] = base;
    }
  }
  return out;
}

/** The path part of a stated base URL, without a trailing slash; null when not stated. */
function basePath(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "parenthesized_expression") return basePath(node.namedChildren[0]);
  if (node.type === "binary_expression") {
    const op = node.childForFieldName("operator")?.text;
    if (op === "||" || op === "??") return basePath(node.childForFieldName("right"));
    return null;
  }
  let text: string | null = null;
  if (node.type === "string") text = node.text.slice(1, -1);
  else if (node.type === "template_string" && !node.namedChildren.some((c) => c.type === "template_substitution")) {
    text = node.text.slice(1, -1);
  }
  if (text === null) return null;
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(.*)$/i.exec(text)?.[1] ?? text;
  if (path !== "" && !path.startsWith("/")) return null;
  return path.replace(/\/+$/, "");
}
