import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { splitLines } from "../../shared/source-lines.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";
import { splitTopLevel } from "./regex-base.js";

/**
 * GraphQL SDL — the schema grammar, shared by the GraphQL plugin (schema
 * files) and any plugin whose code embeds a schema (Apollo's inline
 * `typeDefs = gql\`type Query …\``). Schema definition files (`.graphql`/`.gql`/`.graphqls`). A GraphQL API's
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
 *
 * The schema is the contract, so the route attribute layer is filled from it
 * with nothing `inferred`: field arguments → `params` (binding `body` — they
 * travel as operation variables in the POST body; the type text keeps `!`),
 * auth-style directives on the field (or its root type, inherited) → `auth`
 * (`@auth(requires: ADMIN)` / `@hasRole(role: "X")` → roles, `@isAuthenticated`
 * → policy, `@public` → anonymous), `@deprecated(…)` → a `middleware` entry as
 * written (GraphQL has no API versioning, so `deprecatedVersions` stays
 * absent). Type fields keep their raw type text (`[Order!]!`) and `!` sets
 * `isRequired`, which `request-schema.ts` reads back for a body schema.
 */

const ROOT_TYPES = new Set(["Query", "Mutation", "Subscription"]);
const BUILTIN_SCALARS = new Set(["ID", "String", "Int", "Float", "Boolean"]);

interface GqlArg {
  name: string;
  /** As written, wrappers included (`ID!`, `[String!]`). */
  type: string;
}

interface GqlField {
  name: string;
  /** The field's type with list/non-null wrappers stripped (`[Order!]!` → `Order`). */
  typeName: string;
  /** As written, wrappers included (`[Order!]!`). */
  rawType: string;
  isList: boolean;
  /** Outer `!` — the field is non-null. */
  isRequired: boolean;
  args: GqlArg[];
  /** Directive texts as written, minus the `@` (`auth(requires: ADMIN)`, `deprecated(reason: "x")`). */
  directives: string[];
  line: number;
}

interface GqlType {
  kind: string; // type | interface | input | enum | scalar | union
  name: string;
  fields: GqlField[];
  /** Directives on the type header itself. */
  directives: string[];
  line: number;
}

/** Strip `#` line comments and `"""…"""` / `"…"` descriptions. */
function stripComments(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*#.*$/gm, "");
}

const NAMED_TYPE_RE = /([A-Za-z_]\w*)/;

/** `[Order!]!` → { typeName: "Order", isList: true, isRequired: true }; `String` → { "String", false, false }. */
function parseFieldType(raw: string): { typeName: string; rawType: string; isList: boolean; isRequired: boolean } | null {
  const rawType = raw.trim();
  const isList = rawType.includes("[");
  const isRequired = rawType.endsWith("!");
  const m = NAMED_TYPE_RE.exec(rawType);
  if (!m) return null;
  return { typeName: m[1]!, rawType, isList, isRequired };
}

/** `@auth(requires: ADMIN) @deprecated(reason: "x")` → ["auth(requires: ADMIN)", 'deprecated(reason: "x")']. */
function parseDirectives(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/@([A-Za-z_]\w*)(\((?:[^()"]|"[^"]*"|\([^)]*\))*\))?/g)) {
    out.push((m[1]! + (m[2] ?? "")).replace(/\s+/g, " "));
  }
  return out;
}

/** `id: ID!, filter: UserFilter = {}` → [{ id, ID! }, { filter, UserFilter }]. */
function parseArgs(text: string): GqlArg[] {
  const out: GqlArg[] = [];
  for (const part of splitTopLevel(text)) {
    const m = /^\s*([A-Za-z_]\w*)\s*:\s*([^=@]+)/.exec(part);
    if (m) out.push({ name: m[1]!, type: m[2]!.trim() });
  }
  return out;
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
  const srcLines = splitLines(src);
  const types: GqlType[] = [];
  const headerRe = /^\s*(?:extend\s+)?(type|interface|input|enum|scalar|union)\s+([A-Za-z_]\w*)(.*)$/;
  const fieldRe = /^\s*([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:\s*([\[\]A-Za-z_!\s]+?)\s*(@.*|=.*)?$/;

  const braceDelta = (s: string) => (s.match(/\{/g)?.length ?? 0) - (s.match(/\}/g)?.length ?? 0);

  let current: GqlType | null = null;
  let depth = 0;
  for (let i = 0; i < srcLines.length; i++) {
    let line = srcLines[i]!;
    const startLine = i + 1;
    // An argument list may wrap (`user(\n  id: ID!\n): User`): join it onto
    // its opening line so the inner `name: Type` lines never read as fields.
    if (current && line.includes("(") && !line.includes(")")) {
      let j = i + 1;
      while (j < srcLines.length && !line.includes(")")) line += " " + srcLines[j++]!.trim();
      i = j - 1;
    }
    if (!current) {
      const h = headerRe.exec(line);
      if (!h) continue;
      const t: GqlType = { kind: h[1]!, name: h[2]!, fields: [], directives: parseDirectives(h[3] ?? ""), line: startLine };
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
      const ft = parseFieldType(f[3]!);
      if (ft) {
        current.fields.push({
          name: f[1]!,
          typeName: ft.typeName,
          rawType: ft.rawType,
          isList: ft.isList,
          isRequired: ft.isRequired,
          args: f[2] ? parseArgs(f[2]) : [],
          directives: parseDirectives(f[4] ?? ""),
          line: startLine,
        });
      }
    }
    if (depth <= 0) current = null;
  }
  return types;
}

// ─── Directives → guards ───────────────────────────────────────────────────────

/** Directive names that gate access, across the common schema-directive libraries. */
const AUTH_DIRECTIVES = new Set([
  "auth", "authorize", "authorized", "authenticated", "isAuthenticated", "requireAuth", "requiresAuth",
  "hasRole", "hasRoles", "hasPermission", "hasScope", "hasScopes", "requireRole", "requiresRole",
  "permission", "permissions", "protected", "secured", "roles", "role", "guard", "access",
]);
const ANONYMOUS_DIRECTIVES = new Set(["public", "anonymous", "skipAuth", "allowAnonymous", "noAuth"]);
const ROLE_ARGS = new Set(["requires", "role", "roles", "hasRole", "requiredRole", "requiredRoles"]);

/** `requires: ADMIN` / `roles: ["A", "B"]` / `role: "X"` → the bare names. */
function argValues(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|\b([A-Z][A-Z0-9_]*)\b/g)]
    .map((m) => m[1] ?? m[2]!)
    .filter((v) => v.length > 0);
}

/** An auth directive as a guard, or null for anything else. */
export function guardOfDirective(directive: string): GuardAttr | null {
  const m = /^([A-Za-z_]\w*)(?:\((.*)\))?$/s.exec(directive);
  if (!m) return null;
  const name = m[1]!;
  const text = `@${directive}`;
  if (ANONYMOUS_DIRECTIVES.has(name)) return { text, anonymous: true };
  if (!AUTH_DIRECTIVES.has(name)) return null;
  const args = m[2] ?? "";
  if (!args.trim()) return { text, policies: [name] };
  const roles: string[] = [];
  const policies: string[] = [];
  for (const arg of splitTopLevel(args)) {
    const kv = /^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/s.exec(arg);
    if (!kv) continue;
    const values = argValues(kv[2]!);
    if (ROLE_ARGS.has(kv[1]!)) roles.push(...values);
    else policies.push(...values.map((v) => `${kv[1]}:${v}`));
  }
  if (roles.length === 0 && policies.length === 0) policies.push(name);
  return { text, roles, policies };
}

function guardsOf(directives: string[]): GuardAttr[] {
  const out: GuardAttr[] = [];
  for (const d of directives) {
    const g = guardOfDirective(d);
    if (g) out.push(g);
  }
  return out;
}

// ─── Routes: root-type fields → synthetic /graphql/<field> api routes ──────────

export function extractGraphqlRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const t of parsedOf(lines)) {
    if (!ROOT_TYPES.has(t.name)) continue;
    const inheritedGuards = guardsOf(t.directives);
    for (const field of t.fields) {
      const route: RouteInfo = {
        path: `/graphql/${field.name}`,
        httpMethod: "POST",
        kind: "api",
        handler: field.name,
        calls: [],
        middleware: [],
        line: field.line,
      };
      // Arguments arrive as operation variables in the POST body.
      const params: RouteParamInfo[] = field.args.map((a) => ({ name: a.name, type: a.type, binding: "body" }));
      applyRouteMeta(route, { inheritedGuards, guards: guardsOf(field.directives), params });
      // No API versioning in GraphQL: deprecation is recorded as the directive text.
      for (const d of field.directives) if (/^deprecated\b/.test(d)) route.middleware.push(`@${d}`);
      routes.push(route);
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
    const props: PropertyInfo[] = t.fields.map((f) => {
      const p: PropertyInfo = {
        name: f.name,
        type: f.rawType,
        visibility: "public",
        isStatic: false,
        isReadonly: false,
      };
      if (f.isRequired) p.isRequired = true;
      return p;
    });
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

