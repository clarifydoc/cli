import type { Node, Tree } from "web-tree-sitter";

/**
 * URL-holding markup attributes a script reads — `el.getAttribute('data-update-url')`,
 * `el.dataset.updateUrl` (read as `data-update-url`) — each with the verb its
 * function requests with when the function names exactly one: a verb-named
 * call (`POST(url, …)`, `apiPatch(url, …)`), a `method: 'PUT'`, or a default
 * (`el.getAttribute('data-method') || 'POST'`). Markup elements carrying the
 * attribute make that request (core/attribute-requests.ts).
 */

const READ_RE = /\.getAttribute\(\s*(['"])(data-[\w-]*url)\1\s*\)|\.dataset\.(\w*Url)\b|\.dataset\[\s*(['"])(\w*Url)\4\s*\]/g;
const VERB_RE = /(?<![\w.])(?:api|fetch|request|http)?(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)(?:Json|JSON)?\s*\(|\bmethod\s*:\s*['"](get|post|put|patch|delete|GET|POST|PUT|PATCH|DELETE)['"]|\|\|\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g;
const FUNCTION_TYPES = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration"]);

const kebab = (camel: string): string => `data-${camel.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The innermost function whose text holds `index`, found by descending through the children that hold it (the
 * methods of `Node` a flat copy of the tree also answers; no `descendantForIndex`, whose answer at the edge
 * between two siblings is the tree's own).
 */
function innermostFunctionAt(root: Node, index: number): Node | null {
  let found: Node | null = null;
  for (let node: Node | undefined = root; node; ) {
    if (FUNCTION_TYPES.has(node.type)) found = node;
    node = node.children.find((c) => c.startIndex <= index && index < c.endIndex);
  }
  return found;
}

export function extractAttributeReads(tree: Tree, sourceText: string): Array<{ attribute: string; method?: string; line: number }> {
  if (!/getAttribute\(\s*['"]data-[\w-]*url['"]|\.dataset(?:\.\w*Url\b|\[)/.test(sourceText)) return [];
  const out: Array<{ attribute: string; method?: string; line: number }> = [];
  const verbsIn = new Map<number, Set<string>>();
  for (const m of sourceText.matchAll(READ_RE)) {
    const attribute = (m[2] ?? kebab((m[3] ?? m[5])!)).toLowerCase();
    const node = innermostFunctionAt(tree.rootNode, m.index!);
    let method: string | undefined;
    if (node) {
      let verbs = verbsIn.get(node.id);
      if (!verbs) {
        verbs = new Set([...node.text.matchAll(VERB_RE)].map((v) => (v[1] ?? v[2] ?? v[3])!.toUpperCase()));
        verbsIn.set(node.id, verbs);
      }
      if (verbs.size === 1) method = [...verbs][0]!;
    }
    let line = 1;
    for (let i = 0; i < m.index!; i++) if (sourceText.charCodeAt(i) === 10) line++;
    out.push({ attribute, ...(method ? { method } : {}), line });
  }
  return out;
}
