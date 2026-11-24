import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { newSpecNode, parseSpecDocument, type SpecNode } from "../../shared/spec-document.js";

/**
 * OpenAPI / Swagger API-description documents (`.yaml`/`.yml`/`.json`) — the
 * industry-standard contract-first spec format. Like JSight, the spec is often
 * the ONLY in-repo statement of the served API surface (the implementing
 * controllers are generated, or live in another repo behind a gateway), so its
 * paths become `api` routes that the symbol-linker joins to their handlers by
 * `operationId`, and both spec halves become a bridge between a frontend
 * `fetch("/users")` and a backend controller that otherwise wouldn't match.
 *
 *   paths:
 *     /users:
 *       get:
 *         operationId: listUsers      → GET /users  (handler: listUsers)
 *     /users/{id}:
 *       get:
 *         operationId: getUser        → GET /users/{id}  (handler: getUser)
 *   components:
 *     schemas:
 *       User:                         → entity "User" (data-model node)
 *         properties:
 *           id: { type: integer }
 *           orders:
 *             type: array
 *             items: { $ref: '#/components/schemas/Order' }  → User → Order (1:N)
 *
 * The spec IS the contract, so the route attribute layer is filled from the
 * document itself and nothing on it is `inferred`: `parameters` (path-item
 * level merged with operation level) → `params` with their `in` binding,
 * `requestBody` → one body param typed by its schema, `security` (operation
 * level, else root) → `auth` (scheme names → schemes, scopes → roles, an
 * empty `security: []` → anonymous), `deprecated: true` → the spec version in
 * `deprecatedVersions`. Schema properties keep their JSON type words (plus
 * `(format)`, `[]` for arrays, `?` for nullable) so the request-schema hooks
 * in `request-schema.ts` can flatten a body schema back to JSON Schema.
 *
 * The document is claimed by extension but content-sniffed in meta.preprocess,
 * so every non-spec yaml/json (package.json, k8s manifests, CI configs) is
 * skipped and never surfaces as an analyzed file.
 */

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);


function itemsOf(node: SpecNode | undefined): SpecNode[] {
  return node?.items ?? [];
}

function get(node: SpecNode | undefined, ...path: string[]): SpecNode | undefined {
  let cur = node;
  for (const key of path) {
    cur = cur?.children.get(key);
    if (!cur) return undefined;
  }
  return cur;
}

// ─── Type texts ───────────────────────────────────────────────────────────────

/** `#/components/schemas/User` / `#/definitions/User` → `User`. */
export function refName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  // A pointer INTO a schema (`…#/components/schemas/Club/properties/id`) is that member's
  // schema, which names no type: its last segment is the member, never a schema.
  const fragment = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
  if (/\/(?:properties|items|additionalProperties|allOf|oneOf|anyOf|not|patternProperties)(?:\/|$)/.test(fragment)) return null;
  // `./school/School.yaml` — a schema kept in a file of its own is named after the file.
  const seg = ref.split("/").pop()?.replace(/\.(?:ya?ml|json)$/i, "");
  return seg && /^[A-Za-z_]/.test(seg) ? seg : null;
}

/** A `$ref` to another file's whole document (`./school/School.yaml`), not to a fragment of this one. */
const isFileRef = (ref: string | null | undefined): boolean => !!ref && !ref.includes("#") && /\.(?:ya?ml|json)$/i.test(ref);

/**
 * The type text of a schema object, in the spelling `request-schema.ts` reads
 * back: a `$ref` → its name, `type: array` → `<items>[]`, a scalar with a
 * `format` → `string(date-time)`, `nullable: true` → trailing `?`.
 */
export function schemaTypeText(schema: SpecNode | undefined): string | null {
  if (!schema) return null;
  const ref = refName(schema.children.get("$ref")?.value);
  if (ref) return ref;
  const declared = schema.children.get("type")?.value ?? null;
  let text: string | null;
  if (declared === "array") {
    const inner = schemaTypeText(schema.children.get("items"));
    text = `${inner ?? "any"}[]`;
  } else if (declared) {
    const format = schema.children.get("format")?.value;
    text = format ? `${declared}(${format})` : declared;
  } else {
    // allOf/oneOf with a single ref reads as that type.
    const composed = ["allOf", "oneOf", "anyOf"]
      .map((k) => itemsOf(schema.children.get(k)))
      .find((xs) => xs.length > 0);
    const first = composed?.length === 1 ? refName(composed[0]!.children.get("$ref")?.value) : null;
    text = first ?? (schema.children.has("properties") ? "object" : null);
  }
  if (text && schema.children.get("nullable")?.value === "true") text += "?";
  return text;
}

// ─── Route extraction ─────────────────────────────────────────────────────────

const IN_BINDINGS: Record<string, RouteParamBinding> = {
  path: "route",
  query: "query",
  header: "header",
  cookie: "header",
  body: "body", // Swagger 2
  formData: "form", // Swagger 2
};

/**
 * Resolve a local `$ref` into `components.<section>` / Swagger 2 `<section>`,
 * following a chain of them. A ref into another file stops the chain: that
 * node (still carrying the `$ref`) is returned, never a same-named local one.
 */
function resolveRef(root: SpecNode, node: SpecNode, section: string): SpecNode {
  let cur = node;
  for (let hop = 0; hop < 4; hop++) {
    const ref = cur.children.get("$ref")?.value;
    if (!ref?.startsWith("#")) return cur;
    const name = ref.split("/").pop() ?? "";
    const next = get(root, "components", section, name) ?? get(root, section, name);
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** `headers.yaml#/customerId` → `customerId`; `common/limit.yaml` → `limit`. */
function externalRefName(ref: string): string | null {
  const [file = "", fragment = ""] = ref.split("#");
  const seg = fragment.split("/").filter(Boolean).pop()
    ?? file.split("/").pop()?.replace(/\.(ya?ml|json)$/i, "");
  return seg || null;
}

function paramOf(root: SpecNode, raw: SpecNode): RouteParamInfo | null {
  const p = resolveRef(root, raw, "parameters");
  const name = p.children.get("name")?.value;
  const where = p.children.get("in")?.value;
  if (!name || !where) {
    // Defined in a file the analysis does not have (often unpacked into the
    // build output): keep that the operation takes it, under the ref's name.
    const ref = p.children.get("$ref")?.value;
    const refName = ref && !ref.startsWith("#") ? externalRefName(ref) : null;
    return ref && refName ? { name: refName, type: null, binding: null, ref } : null;
  }
  const binding = IN_BINDINGS[where] ?? null;
  // OpenAPI 3 nests the type under `schema`; Swagger 2 puts it on the parameter.
  const type = schemaTypeText(p.children.get("schema")) ?? schemaTypeText(p);
  return { name, type, binding };
}

function paramsOf(root: SpecNode, pathNode: SpecNode, opNode: SpecNode): RouteParamInfo[] {
  const byKey = new Map<string, RouteParamInfo>();
  // Operation-level parameters override a same-named path-item one.
  for (const list of [pathNode.children.get("parameters"), opNode.children.get("parameters")]) {
    for (const item of itemsOf(list)) {
      const p = paramOf(root, item);
      if (p) byKey.set(`${p.binding}:${p.name}`, p);
    }
  }
  const out = [...byKey.values()];
  const body = resolveRef(root, opNode.children.get("requestBody") ?? newSpecNode(0), "requestBodies");
  const content = body.children.get("content");
  if (content) {
    const first = content.children.values().next().value as SpecNode | undefined;
    const schema = first?.children.get("schema");
    const target = schema ? resolveRef(root, schema, "schemas") : undefined;
    // `$ref: Filters` with `Filters: { type: array, items: $ref Filter }`: the body is
    // that array, which a property-less class of the alias's name cannot say.
    const alias = target && target !== schema && target.children.get("type")?.value === "array" ? schemaTypeText(target) : null;
    const inline = schema && !schema.children.has("$ref") ? schema.children.get("properties") : undefined;
    if (inline && inline.children.size > 0 && !inline.children.has("body")) {
      // An inline object body (`schema: { type: object, properties: { state: … } }`):
      // no class names it, so its fields are the body's.
      for (const [name, prop] of inline.children) out.push({ name, type: schemaTypeText(prop), binding: "body" });
    } else {
      out.push({ name: "body", type: alias ?? schemaTypeText(schema), binding: "body" });
    }
  }
  return out;
}

/** `security:` requirement objects → guards; an empty list waives every guard. */
function guardsOf(security: SpecNode | undefined): GuardAttr[] {
  if (!security) return [];
  const items = itemsOf(security);
  if (items.length === 0) return [{ text: "security: []", anonymous: true }];
  const out: GuardAttr[] = [];
  for (const req of items) {
    // `- {}` among the alternatives: the operation may also be called with no credentials.
    if (req.children.size === 0 && (req.value === null || req.value.trim() === "{}")) out.push({ text: "{}", anonymous: true });
    for (const [scheme, scopesNode] of req.children) {
      const scopes = itemsOf(scopesNode).map((s) => s.value).filter((s): s is string => !!s);
      out.push({
        text: scopes.length > 0 ? `${scheme}[${scopes.join(", ")}]` : scheme,
        schemes: [scheme],
        roles: scopes,
      });
    }
  }
  return out;
}

/**
 * The path OpenAPI 3 `servers` serve every operation under:
 * `https://api.example.com/league-api` → `/league-api`, `/api/v3` as written,
 * `{variables}` filled from their defaults. `undefined` when no server is
 * listed (the enclosing level's applies), `""` when the servers do not agree:
 * a gateway URL beside a bare `localhost` one says the prefix is the
 * gateway's, not the service's.
 */
function serversBasePath(servers: SpecNode | undefined): string | undefined {
  const items = itemsOf(servers);
  if (items.length === 0) return undefined;
  const paths = new Set<string | null>();
  for (const server of items) {
    const vars = server.children.get("variables");
    const url = (server.children.get("url")?.value ?? "")
      .replace(/\{([^}]+)\}/g, (m, name: string) => get(vars, name, "default")?.value ?? m)
      .replace(/^([a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
    paths.add(url === "" || (url.startsWith("/") && !url.includes("{")) ? url : null);
  }
  const [only] = paths;
  return paths.size === 1 && only != null ? only : "";
}

export function extractOpenApiRoutes(lines: string[]): RouteInfo[] {
  const root = parseSpecDocument(lines);
  const paths = root.children.get("paths");
  if (!paths) return [];
  const routes: RouteInfo[] = [];
  // A shared basePath (Swagger 2 `basePath: /v1`) prefixes every route path;
  // OpenAPI 3 states it as the path of `servers[].url`, at the root, a path
  // item or an operation (the innermost listing wins).
  const basePath = (root.children.get("basePath")?.value ?? "").replace(/\/$/, "");
  const rootServers = basePath ? undefined : serversBasePath(root.children.get("servers"));
  const version = get(root, "info", "version")?.value ?? null;
  const rootGuards = guardsOf(root.children.get("security"));
  for (const [rawPath, pathNode] of paths.children) {
    if (!rawPath.startsWith("/")) continue;
    const pathServers = basePath ? undefined : serversBasePath(pathNode.children.get("servers"));
    for (const [method, opNode] of pathNode.children) {
      if (!HTTP_METHODS.has(method)) continue;
      const prefix = basePath
        || (serversBasePath(opNode.children.get("servers")) ?? pathServers ?? rootServers ?? "");
      const fullPath = prefix ? `${prefix}${rawPath}` : rawPath;
      const operationId = opNode.children.get("operationId")?.value ?? null;
      // openapi-generator names the server interface after the operation's first
      // tag (`users` → `UsersApi`): what an implementing class `implements`.
      const tagNode = opNode.children.get("tags");
      const tag = tagNode?.items?.[0]?.value ?? tagNode?.value?.replace(/^\[|\]$/g, "").split(",")[0]?.trim().replace(/^["']|["']$/g, "");
      const apiInterface = tag ? `${tag.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _s, c: string) => c.toUpperCase())}Api` : null;
      const route: RouteInfo = {
        path: fullPath,
        httpMethod: method.toUpperCase(),
        kind: "api",
        handler: operationId,
        calls: [],
        middleware: [],
        line: opNode.line,
        ...(operationId && apiInterface ? { contract: { type: apiInterface, method: operationId } } : {}),
      };
      const ownSecurity = opNode.children.get("security");
      const deprecated = opNode.children.get("deprecated")?.value === "true";
      applyRouteMeta(route, {
        inheritedGuards: ownSecurity ? [] : rootGuards,
        guards: guardsOf(ownSecurity),
        versions: version ? [version] : undefined,
        deprecatedVersions: version && deprecated ? [version] : undefined,
        params: paramsOf(root, pathNode, opNode),
      });
      if (deprecated && !version) route.middleware.push("deprecated");
      routes.push(route);
    }
  }
  return routes;
}

// ─── Schema → entity extraction ────────────────────────────────────────────────

function schemasNode(root: SpecNode): SpecNode | undefined {
  return root.children.get("components")?.children.get("schemas") // OpenAPI 3
    ?? root.children.get("definitions"); // Swagger 2
}

/** `properties:` of a schema plus those of inline `allOf` members. */
function propertyNodes(schema: SpecNode): Array<[string, SpecNode]> {
  const out: Array<[string, SpecNode]> = [];
  const props = schema.children.get("properties");
  if (props) out.push(...props.children);
  for (const part of itemsOf(schema.children.get("allOf"))) {
    const inner = part.children.get("properties");
    if (inner) out.push(...inner.children);
  }
  return out;
}

function requiredNames(schema: SpecNode): Set<string> {
  const names = new Set<string>();
  for (const s of [schema, ...itemsOf(schema.children.get("allOf"))]) {
    for (const item of itemsOf(s.children.get("required"))) if (item.value) names.add(item.value);
  }
  return names;
}

export function extractOpenApiEntities(lines: string[]): ClassInfo[] {
  const schemas = schemasNode(parseSpecDocument(lines));
  if (!schemas) return [];
  const out: ClassInfo[] = [];
  for (const [name, schema] of schemas.children) {
    if (/^[A-Za-z_]/.test(name)) out.push(schemaClass(name, schema));
  }
  return out;
}

/** One schema as an entity: its properties (inline `allOf` members' too) and the schemas it composes. */
export function schemaClass(name: string, schema: SpecNode): ClassInfo {
  const required = requiredNames(schema);
  const props: PropertyInfo[] = [];
  for (const [propName, prop] of propertyNodes(schema)) {
    const info: PropertyInfo = {
      name: propName,
      type: schemaTypeText(prop),
      visibility: "public",
      isStatic: false,
      isReadonly: prop.children.get("readOnly")?.value === "true",
    };
    if (required.has(propName)) info.isRequired = true;
    // `id: { $ref: '../api-spec/league-api.yaml#/components/schemas/Club/properties/id' }`: a copy of that member.
    const memberRef = prop.children.get("$ref")?.value;
    if (memberRef && /#.*\/properties\/[^/]+$/.test(memberRef)) info.ref = memberRef;
    props.push(info);
  }
  // `allOf: [$ref: Base, {…}]` is schema inheritance: the base's properties
  // are flattened by the request-schema pass through `extends`, those of a
  // second and later parent through `implements`.
  const parents = [...new Set(itemsOf(schema.children.get("allOf"))
    .map((p) => refName(p.children.get("$ref")?.value))
    .filter((r): r is string => !!r && r !== name))];
  return {
    name,
    extends: parents[0] ?? null,
    implements: parents.slice(1),
    decorators: ["entity", "openapi"],
    methods: [],
    properties: props,
    isExported: true,
    line: schema.line,
    endLine: schema.line,
  };
}

export function extractOpenApiRelations(lines: string[], classes: ClassInfo[]): EntityRelation[] {
  const schemas = schemasNode(parseSpecDocument(lines));
  if (!schemas) return [];
  const known = new Set(classes.map((c) => c.name));
  return [...schemas.children].flatMap(([name, schema]) => schemaRelations(name, schema, known));
}

/**
 * The schema a node names: its own `$ref`, or the one ref of a single-member
 * `allOf` / `oneOf` / `anyOf` (OpenAPI 3.0's way to put a description beside a `$ref`).
 */
function refOf(node: SpecNode | undefined): string | undefined {
  if (!node) return undefined;
  const own = node.children.get("$ref")?.value;
  if (own) return own;
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    const refs = itemsOf(node.children.get(key)).map((p) => p.children.get("$ref")?.value).filter((r): r is string => !!r);
    if (refs.length === 1 && itemsOf(node.children.get(key)).length === 1) return refs[0];
  }
  return undefined;
}

/** A schema's properties that hold another schema: one of `known`, or a file of its own. */
function schemaRelations(name: string, schema: SpecNode, known: ReadonlySet<string>): EntityRelation[] {
  const out: EntityRelation[] = [];
  for (const [field, prop] of propertyNodes(schema)) {
    const directRef = refOf(prop);
    // An array's items, or a map's values (`additionalProperties: { $ref }`): many of them.
    const itemRef = refOf(prop.children.get("items")) ?? refOf(prop.children.get("additionalProperties"));
    const direct = refName(directRef);
    const arrayItem = refName(itemRef);
    const to = direct ?? arrayItem;
    if (!to || to === name || !(known.has(to) || isFileRef(direct ? directRef : itemRef))) continue;
    out.push({
      fromEntity: name,
      fromField: field,
      toEntity: to,
      cardinality: arrayItem ? "one-to-many" : "many-to-one",
      orm: "openapi",
      confidence: "EXTRACTED",
    });
  }
  return out;
}

/**
 * A schema kept in a file of its own (`school/School.yaml`, which the spec
 * names by `$ref: './school/School.yaml'`): its root is the schema, named
 * after the file.
 */
export function extractSchemaFragment(lines: string[], name: string): { classes: ClassInfo[]; relations: EntityRelation[] } {
  const root = parseSpecDocument(lines);
  return { classes: [schemaClass(name, root)], relations: schemaRelations(name, root, new Set()) };
}

export const openapiSpec: RegexLangSpec = {
  language: "openapi",
  extensions: [".yaml", ".yml", ".json"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["#"],
  extractRoutes: (lines) => extractOpenApiRoutes(lines),
  extractClasses: (lines) => extractOpenApiEntities(lines),
  extractEntityRelations: (lines, classes) => extractOpenApiRelations(lines, classes),
};
