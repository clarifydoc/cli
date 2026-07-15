import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * GraphQL schema definition files (`.graphql`/`.gql`, SDL). A GraphQL API's
 * contract lives entirely in the schema, so it plays the same contract-first
 * role as OpenAPI/WSDL for the linker:
 *
 *   type User {                         → entity "User" (data-model node)
 *     id: ID!
 *     orders: [Order!]!                 → User → Order (one-to-many)
 *   }
 *   type Query {
 *     users: [User!]!                   → route POST /graphql/users  (handler: users)
 *     user(id: ID!): User               → route POST /graphql/user   (handler: user)
 *   }
 *   type Mutation {
 *     createUser(input: NewUser!): User → route POST /graphql/createUser
 *   }
 *
 * Each root Query/Mutation/Subscription field becomes a synthetic
 * `POST /graphql/<field>` `api` route whose handler is the field name — the
 * symbol-linker joins it to the same-named resolver, and frontend `gql`
 * operations (extracted in the javascript plugin as api-calls with the SAME
 * synthetic URL) join to it through the standard api↔route path match, so the
 * chain component → operation → schema field → resolver → DB is complete.
 */

const ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);
const BUILTIN_SCALARS = new Set(["ID", "String", "Int", "Float", "Boolean"]);

interface GqlField {
  name: string;
  /** The field's type with list/non-null wrappers stripped (`[Order!]!` → `Order`). */
  typeName: string;
  isList: boolean;
  line: number;
}

interface GqlType {
  kind: string; // type | interface | input | enum | scalar | union
  name: string;
  fields: GqlField[];
  line: number;
}

/** Strip `#` line comments and `"""…"""` / `"…"` descriptions. */
function stripComments(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*#.*$/gm, "");
}

const NAMED_TYPE_RE = /([A-Za-z_]\w*)/;

/** `[Order!]!` → { typeName: "Order", isList: true }; `String!` → { "String", false }. */
function parseFieldType(raw: string): { typeName: string; isList: boolean } | null {
  const isList = raw.includes("[");
  const m = NAMED_TYPE_RE.exec(raw);
  if (!m) return null;
  return { typeName: m[1]!, isList };
}

const PARSE_CACHE = new WeakMap<string[], GqlType[]>();

function parsedOf(lines: string[]): GqlType[] {
  let types = PARSE_CACHE.get(lines);
  if (!types) {
    types = parseSchema(lines);
    PARSE_CACHE.set(lines, types);
  }
  return types;
}

function parseSchema(lines: string[]): GqlType[] {
  const src = stripComments(lines.join("\n"));
  const srcLines = src.split("\n");
  const types: GqlType[] = [];
  const headerRe = /^\s*(?:extend\s+)?(type|interface|input|enum|scalar|union)\s+([A-Za-z_]\w*)/;
  const fieldRe = /^\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:\s*(.+?)\s*$/;

  const braceDelta = (s: string) => (s.match(/\{/g)?.length ?? 0) - (s.match(/\}/g)?.length ?? 0);

  let current: GqlType | null = null;
  let depth = 0;
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i]!;
    if (!current) {
      const h = headerRe.exec(line);
      if (!h) continue;
      const t: GqlType = { kind: h[1]!, name: h[2]!, fields: [], line: i + 1 };
      types.push(t);
      // Scalars/unions have no field block; a header with no `{` opens no block
      // (brace-on-next-line SDL is uncommon and treated as fieldless).
      if (h[1] === "scalar" || h[1] === "union" || !line.includes("{")) continue;
      current = t;
      depth = braceDelta(line);
      if (depth <= 0) current = null;
      continue;
    }
    // Inside a type block: track brace depth, capture field declarations.
    depth += braceDelta(line);
    const f = fieldRe.exec(line);
    if (f && current.kind !== "enum") {
      const ft = parseFieldType(f[2]!);
      if (ft) current.fields.push({ name: f[1]!, typeName: ft.typeName, isList: ft.isList, line: i + 1 });
    }
    if (depth <= 0) current = null;
  }
  return types;
}

// ─── Routes: root-type fields → synthetic /graphql/<field> api routes ──────────

export function extractGraphqlRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const t of parsedOf(lines)) {
    if (!ROOT_TYPES.has(t.name)) continue;
    for (const field of t.fields) {
      routes.push({
        path: `/graphql/${field.name}`,
        httpMethod: "POST",
        kind: "api",
        handler: field.name,
        calls: [],
        middleware: [],
        line: field.line,
      });
    }
  }
  return routes;
}

// ─── Entities: object/interface/input types → data-model nodes ─────────────────

function isEntityType(t: GqlType): boolean {
  return (t.kind === "type" || t.kind === "interface" || t.kind === "input") && !ROOT_TYPES.has(t.name);
}

export function extractGraphqlEntities(lines: string[]): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (const t of parsedOf(lines)) {
    if (!isEntityType(t)) continue;
    const props: PropertyInfo[] = t.fields.map((f) => ({
      name: f.name,
      type: f.isList ? `[${f.typeName}]` : f.typeName,
      visibility: "public",
      isStatic: false,
      isReadonly: false,
    }));
    out.push({
      name: t.name,
      extends: null,
      implements: [],
      decorators: ["entity", "graphql"],
      methods: [],
      properties: props,
      isExported: true,
      line: t.line,
      endLine: t.line,
    });
  }
  return out;
}

export function extractGraphqlRelations(lines: string[], classes: ClassInfo[]): EntityRelation[] {
  const known = new Set(classes.map((c) => c.name));
  const out: EntityRelation[] = [];
  for (const t of parsedOf(lines)) {
    if (!isEntityType(t)) continue;
    for (const field of t.fields) {
      // Object-typed field → relation; scalars/enums are plain columns.
      if (BUILTIN_SCALARS.has(field.typeName) || !known.has(field.typeName) || field.typeName === t.name) continue;
      out.push({
        fromEntity: t.name,
        fromField: field.name,
        toEntity: field.typeName,
        cardinality: field.isList ? "one-to-many" : "many-to-one",
        orm: "graphql",
        confidence: "EXTRACTED",
      });
    }
  }
  return out;
}

export const graphqlSpec: RegexLangSpec = {
  language: "graphql",
  extensions: [".graphql", ".gql"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["#"],
  extractRoutes: (lines) => extractGraphqlRoutes(lines),
  extractClasses: (lines) => extractGraphqlEntities(lines),
  extractEntityRelations: (lines, classes) => extractGraphqlRelations(lines, classes),
};
