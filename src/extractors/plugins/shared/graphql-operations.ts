import type { DataSourceInfo } from "../../../types/analysis.js";

/**
 * Parse GraphQL OPERATION documents (client-side `gql`…`` / `graphql`…``
 * templates), shared by any plugin whose frontend embeds them (javascript).
 * The GraphQL SCHEMA plugin parses SDL type/field definitions — a different
 * grammar — so this lives in shared rather than being imported across plugins.
 *
 * Each root selection of an operation names a Query/Mutation field the backend
 * schema serves; emitting one api-call per root field, targeting the same
 * synthetic `/graphql/<field>` URL the schema plugin's route carries, lets the
 * standard api↔route join connect a component to its resolver.
 */

/** Strip `#` comments and `"""…"""` / `"…"` descriptions (blanked, keep newlines). */
function stripGqlComments(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/#[^\n]*/g, "");
}

/**
 * Root selection-set fields of a GraphQL operation document. Handles named
 * operations (`query GetUsers($id: ID!) { user(id:$id) { … } }`), anonymous
 * shorthand (`{ users { … } }`), and documents that also declare fragments
 * (the operation's brace is located, not merely the first `{`). Returns [] for
 * fragment-only documents.
 */
export function parseGqlOperationRootFields(doc: string): string[] {
  const text = stripGqlComments(doc);
  // Locate the operation's selection set: the `{` after a query/mutation/
  // subscription keyword (skipping its variable-definition parens), or a
  // leading `{` for anonymous shorthand. NOT a fragment body.
  let open = -1;
  const opRe = /\b(query|mutation|subscription)\b[^{]*\{/;
  const opMatch = opRe.exec(text);
  if (opMatch) {
    open = opMatch.index + opMatch[0].length - 1;
  } else if (!/\bfragment\b/.test(text) && /^\s*\{/.test(text)) {
    open = text.indexOf("{");
  }
  if (open < 0) return [];

  const fields: string[] = [];
  const tokenRe = /[A-Za-z_]\w*/y;
  let depth = 0;
  let parenDepth = 0; // inside `field(arg: val)` / `@directive(...)` — not selections
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth--; if (depth <= 0) break; i++; continue; }
    if (ch === "(") { parenDepth++; i++; continue; }
    if (ch === ")") { if (parenDepth > 0) parenDepth--; i++; continue; }
    if (depth === 1 && parenDepth === 0 && /[A-Za-z_]/.test(ch)) {
      tokenRe.lastIndex = i;
      const m = tokenRe.exec(text);
      if (m) {
        // `alias: field` — the alias precedes a colon; keep the real field name.
        const isAlias = /^\s*:/.test(text.slice(tokenRe.lastIndex));
        if (!isAlias) fields.push(m[0]);
        i = tokenRe.lastIndex;
        continue;
      }
    }
    i++;
  }
  return [...new Set(fields)];
}

const GQL_TEMPLATE_RE = /\b(?:gql|graphql)\s*`([^`]*)`/g;

/**
 * Scan JS/TS source for `gql`…`` / `graphql`…`` operation templates and emit one
 * `api-call` data source per root field, targeting `/graphql/<field>` with the
 * `post` verb (GraphQL-over-HTTP is POST) — the shape the route-linker joins to
 * the schema plugin's `POST /graphql/<field>` route. Fragment-only templates
 * yield nothing. Cheap-gated by the caller (only runs when the source contains a
 * gql tag).
 */
export function extractGqlOperationCalls(sourceText: string): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  GQL_TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GQL_TEMPLATE_RE.exec(sourceText)) !== null) {
    // A schema template (Apollo `typeDefs`) declares the fields; it calls none.
    if (/\b(?:extend\s+)?type\s+(?:Query|Mutation|Subscription)\b|\bschema\s*\{/.test(m[1]!)) continue;
    const fields = parseGqlOperationRootFields(m[1]!);
    if (fields.length === 0) continue;
    let line = 1;
    for (let i = 0; i < m.index; i++) if (sourceText.charCodeAt(i) === 10) line++;
    for (const field of fields) {
      out.push({
        kind: "api-call",
        // `post` so route-linker's callMethod() reads POST; target is the
        // synthetic per-field URL both tiers share.
        name: "post",
        target: `/graphql/${field}`,
        calls: [],
        line,
      });
    }
  }
  return out;
}

/**
 * A GraphQL document file's operations (`.graphql` beside the client code,
 * read by codegen): one api-call per root field of each `query`, `mutation`
 * or `subscription`, at the operation's line. A schema file has none.
 */
export function extractGqlDocumentCalls(text: string): DataSourceInfo[] {
  const clean = stripGqlComments(text);
  const out: DataSourceInfo[] = [];
  // Each top-level operation starts at depth 0 with its keyword.
  let depth = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[qms]/.test(ch) && (i === 0 || /[\s}]/.test(clean[i - 1]!))) {
      const head = /^(query|mutation|subscription)\b[^{]*\{/.exec(clean.slice(i, i + 400));
      if (!head) continue;
      // The operation's text: from its keyword to the brace that closes its selection set.
      let d = 0;
      let end = i + head[0].length - 1;
      for (; end < clean.length; end++) {
        if (clean[end] === "{") d++;
        else if (clean[end] === "}" && --d === 0) break;
      }
      const line = clean.slice(0, i).split("\n").length;
      for (const field of parseGqlOperationRootFields(clean.slice(i, end + 1))) {
        out.push({ kind: "api-call", name: "post", target: `/graphql/${field}`, calls: [], line });
      }
      i = end;
    }
  }
  return out;
}

