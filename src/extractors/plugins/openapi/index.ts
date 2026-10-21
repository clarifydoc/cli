import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

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

// ─── Minimal structural parser (YAML maps + sequences, JSON) ───────────────────
// OpenAPI's routing/schema skeleton is a tree of string-keyed maps and lists of
// maps; we need keys, nesting, scalar leaf values, list items and `$ref`
// strings — not full YAML (no anchors, no multi-line scalars). A focused indent
// parser avoids a YAML dependency (and the perf cost of one on every sniffed
// yaml). JSON specs are parsed with JSON.parse and folded into the same shape.

export interface SpecNode {
  value: string | null;
  line: number;
  children: Map<string, SpecNode>;
  /** Sequence items (`- name: id` / `- $ref: …` / `- read:users`), in order. */
  items?: SpecNode[];
}

function newNode(line: number): SpecNode {
  return { value: null, line, children: new Map() };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** The `$ref` of a node itself or, legacy shape, of its first `$ref` sequence item. */
function surfaceRef(parent: SpecNode, item: SpecNode): void {
  const ref = item.children.get("$ref");
  if (ref && !parent.children.has("$ref")) parent.children.set("$ref", ref);
}

/** Split `a, b: [c, d], {e: f}` at depth-0 commas. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** `key: value` / `key:` — a mapping needs whitespace (or the end) after the colon, so `read:users` stays a scalar. */
const FLOW_KEY_RE = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:\[\]{},][^:]*?)\s*:(?:\s+(.*))?$/s;

/**
 * Fill `node` from a flow-style scalar (`[a, b]`, `{ type: integer }`,
 * `[bearerAuth: []]`, or a plain value). Recursive over nested flow syntax.
 */
function setFlowValue(node: SpecNode, raw: string): void {
  const text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    node.items = [];
    for (const part of splitFlow(text.slice(1, -1))) {
      const item = newNode(node.line);
      const kv = FLOW_KEY_RE.exec(part);
      if (kv && !/^[\[{]/.test(part.trim())) {
        const child = newNode(node.line);
        setFlowValue(child, kv[2] ?? "");
        item.children.set(stripQuotes(kv[1]!), child);
      } else if (/^\s*[\[{]/.test(part)) {
        setFlowValue(item, part);
      } else {
        item.value = stripQuotes(part);
      }
      node.items.push(item);
      surfaceRef(node, item);
    }
    return;
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    for (const part of splitFlow(text.slice(1, -1))) {
      const kv = FLOW_KEY_RE.exec(part);
      if (!kv) continue;
      const child = newNode(node.line);
      setFlowValue(child, kv[2] ?? "");
      node.children.set(stripQuotes(kv[1]!), child);
    }
    return;
  }
  if (text && text !== "|" && text !== ">") node.value = stripQuotes(text);
}

/** Parse the map/sequence skeleton of a YAML document. */
function parseYaml(lines: string[]): SpecNode {
  const root = newNode(1);
  const stack: Array<{ indent: number; node: SpecNode; isItem?: boolean }> = [{ indent: -1, node: root }];
  // A key may hold a colon not followed by a space (`Fn::GetAtt`, `x:y`), as YAML allows.
  const keyRe = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:](?:[^:]|:(?!\s|$))*?)\s*:(?:\s+|$)(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    const seq = /^(\s*)-(?:\s+(.*))?$/.exec(raw);
    if (seq) {
      const indent = seq[1]!.length;
      const inline = (seq[2] ?? "").replace(/\s+#.*$/, "").trim();
      // Items sit deeper than their key but may share its column
      // (`security:\n- bearerAuth: []`): pop anything deeper, plus the
      // previous item at this same column — never the key itself.
      while (stack.length > 1) {
        const top = stack[stack.length - 1]!;
        if (top.indent > indent || (top.indent === indent && top.isItem)) stack.pop();
        else break;
      }
      const parent = stack[stack.length - 1]!.node;
      const item = newNode(i + 1);
      (parent.items ??= []).push(item);
      stack.push({ indent, node: item, isItem: true });
      const kv = FLOW_KEY_RE.exec(inline);
      if (inline && kv && !/^[\[{]/.test(inline)) {
        const child = newNode(i + 1);
        setFlowValue(child, kv[2] ?? "");
        item.children.set(stripQuotes(kv[1]!), child);
        // The inline key's siblings follow at the key's own column.
        const col = indent + 1 + (raw.slice(indent + 1).match(/^\s*/)?.[0].length ?? 1);
        stack.push({ indent: col, node: child });
      } else if (inline) {
        setFlowValue(item, inline);
      }
      surfaceRef(parent, item);
      continue;
    }
    const m = keyRe.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = stripQuotes(m[2]!);
    const rest = m[3]!.replace(/\s+#.*$/, "").trim();

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    const node = newNode(i + 1);
    setFlowValue(node, rest);
    parent.children.set(key, node);
    stack.push({ indent, node });
  }
  return root;
}

/** Fold a JSON.parse result into the SpecNode shape, tracking a best-effort line. */
function fromJson(obj: unknown, lines: string[], key: string, fromLine: number): SpecNode {
  const line = key ? findLine(lines, key, fromLine) : fromLine;
  const node = newNode(line);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      node.children.set(k, fromJson(v, lines, k, line));
    }
  } else if (Array.isArray(obj)) {
    node.items = [];
    for (const el of obj) {
      const item = fromJson(el, lines, "", line);
      node.items.push(item);
      // Surface a $ref buried in an array (schema `allOf`) at this node.
      surfaceRef(node, item);
    }
  } else if (obj != null) {
    node.value = String(obj);
  }
  return node;
}

function findLine(lines: string[], key: string, fromLine: number): number {
  const needle = `"${key}"`;
  for (let i = Math.max(0, fromLine - 1); i < lines.length; i++) {
    if (lines[i]!.includes(needle)) return i + 1;
  }
  return fromLine;
}

const PARSE_CACHE = new WeakMap<string[], SpecNode>();

function parsedOf(lines: string[]): SpecNode {
  let root = PARSE_CACHE.get(lines);
  if (!root) {
    const text = lines.join("\n");
    if (/^\s*\{/.test(text)) {
      try {
        root = fromJson(JSON.parse(text), lines, "", 1);
      } catch {
        root = newNode(1);
      }
    } else {
      root = parseYaml(lines);
    }
    PARSE_CACHE.set(lines, root);
  }
  return root;
}

/** Exposed for tests: the parsed skeleton of a document. */
export function parseOpenApiDocument(lines: string[]): SpecNode {
  return parsedOf(lines);
}

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
function refName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const seg = ref.split("/").pop();
  return seg && /^[A-Za-z_]/.test(seg) ? seg : null;
}

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
  const body = resolveRef(root, opNode.children.get("requestBody") ?? newNode(0), "requestBodies");
  const content = body.children.get("content");
  if (content) {
    const first = content.children.values().next().value as SpecNode | undefined;
    const type = schemaTypeText(first?.children.get("schema"));
    out.push({ name: "body", type, binding: "body" });
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
  const root = parsedOf(lines);
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
  const schemas = schemasNode(parsedOf(lines));
  if (!schemas) return [];
  const out: ClassInfo[] = [];
  for (const [name, schema] of schemas.children) {
    if (!/^[A-Za-z_]/.test(name)) continue;
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
      props.push(info);
    }
    // `allOf: [$ref: Base, {…}]` is schema inheritance: the base's properties
    // are flattened by the request-schema pass through `extends`.
    const base = itemsOf(schema.children.get("allOf"))
      .map((p) => refName(p.children.get("$ref")?.value))
      .find((r): r is string => !!r && r !== name);
    out.push({
      name,
      extends: base ?? null,
      implements: [],
      decorators: ["entity", "openapi"],
      methods: [],
      properties: props,
      isExported: true,
      line: schema.line,
      endLine: schema.line,
    });
  }
  return out;
}

export function extractOpenApiRelations(lines: string[], classes: ClassInfo[]): EntityRelation[] {
  const schemas = schemasNode(parsedOf(lines));
  if (!schemas) return [];
  const known = new Set(classes.map((c) => c.name));
  const out: EntityRelation[] = [];
  for (const [name, schema] of schemas.children) {
    for (const [field, prop] of propertyNodes(schema)) {
      const direct = refName(prop.children.get("$ref")?.value);
      const arrayItem = refName(prop.children.get("items")?.children.get("$ref")?.value);
      const to = direct ?? arrayItem;
      if (!to || !known.has(to) || to === name) continue;
      out.push({
        fromEntity: name,
        fromField: field,
        toEntity: to,
        cardinality: arrayItem ? "one-to-many" : "many-to-one",
        orm: "openapi",
        confidence: "EXTRACTED",
      });
    }
  }
  return out;
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
