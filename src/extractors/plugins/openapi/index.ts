import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
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
 * The document is claimed by extension but content-sniffed in meta.preprocess,
 * so every non-spec yaml/json (package.json, k8s manifests, CI configs) is
 * skipped and never surfaces as an analyzed file.
 */

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

// ─── Minimal structural parser (YAML maps + JSON) ─────────────────────────────
// OpenAPI's routing/schema skeleton is a tree of string-keyed maps; we only need
// keys, nesting, scalar leaf values, and `$ref` strings — not full YAML. A
// focused indent parser avoids a YAML dependency (and the perf cost of one on
// every sniffed yaml). JSON specs are parsed with JSON.parse and folded into the
// same node shape.

interface SpecNode {
  value: string | null;
  line: number;
  children: Map<string, SpecNode>;
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

/** Parse the map skeleton of a YAML document (sequences/scalars-in-sequences ignored). */
function parseYaml(lines: string[]): SpecNode {
  const root = newNode(1);
  const stack: Array<{ indent: number; node: SpecNode }> = [{ indent: -1, node: root }];
  const keyRe = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s:][^:]*?)\s*:\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*#/.test(raw) || raw.trim() === "") continue;
    // Sequence items (`- $ref: ...`) carry $ref for array element types — keep
    // those, skip other list scalars.
    const seq = /^(\s*)-\s+(.*)$/.exec(raw);
    if (seq) {
      const inline = seq[2]!;
      const refM = /\$ref\s*:\s*(.+)$/.exec(inline);
      if (refM) {
        const parent = stack[stack.length - 1]!.node;
        parent.children.set("$ref", { value: stripQuotes(refM[1]!), line: i + 1, children: new Map() });
      }
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
    if (rest && rest !== "|" && rest !== ">") node.value = stripQuotes(rest);
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
    // Surface a $ref buried in an array (schema `items` / `allOf`) at this node.
    for (const el of obj) {
      if (el && typeof el === "object" && "$ref" in (el as object)) {
        const ref = (el as Record<string, unknown>).$ref;
        if (typeof ref === "string") node.children.set("$ref", { value: ref, line, children: new Map() });
      }
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

// ─── Route extraction ─────────────────────────────────────────────────────────

export function extractOpenApiRoutes(lines: string[]): RouteInfo[] {
  const root = parsedOf(lines);
  const paths = root.children.get("paths");
  if (!paths) return [];
  const routes: RouteInfo[] = [];
  // A shared basePath (Swagger 2 `basePath: /v1`) prefixes every route path.
  const basePath = (root.children.get("basePath")?.value ?? "").replace(/\/$/, "");
  for (const [rawPath, pathNode] of paths.children) {
    if (!rawPath.startsWith("/")) continue;
    const fullPath = basePath ? `${basePath}${rawPath}` : rawPath;
    for (const [method, opNode] of pathNode.children) {
      if (!HTTP_METHODS.has(method)) continue;
      const operationId = opNode.children.get("operationId")?.value ?? null;
      routes.push({
        path: fullPath,
        httpMethod: method.toUpperCase(),
        kind: "api",
        handler: operationId,
        calls: [],
        middleware: [],
        line: opNode.line,
      });
    }
  }
  return routes;
}

// ─── Schema → entity extraction ────────────────────────────────────────────────

/** `#/components/schemas/User` / `#/definitions/User` → `User`. */
function refName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const seg = ref.split("/").pop();
  return seg && /^[A-Za-z_]/.test(seg) ? seg : null;
}

function schemasNode(root: SpecNode): SpecNode | undefined {
  return root.children.get("components")?.children.get("schemas") // OpenAPI 3
    ?? root.children.get("definitions"); // Swagger 2
}

export function extractOpenApiEntities(lines: string[]): ClassInfo[] {
  const schemas = schemasNode(parsedOf(lines));
  if (!schemas) return [];
  const out: ClassInfo[] = [];
  for (const [name, schema] of schemas.children) {
    if (!/^[A-Za-z_]/.test(name)) continue;
    const props: PropertyInfo[] = [];
    const properties = schema.children.get("properties");
    if (properties) {
      for (const [propName, prop] of properties.children) {
        const declared = prop.children.get("type")?.value;
        const ref = refName(prop.children.get("$ref")?.value)
          ?? refName(prop.children.get("items")?.children.get("$ref")?.value);
        props.push({
          name: propName,
          type: ref ?? declared ?? null,
          visibility: "public",
          isStatic: false,
          isReadonly: false,
        });
      }
    }
    out.push({
      name,
      extends: null,
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
    const properties = schema.children.get("properties");
    if (!properties) continue;
    for (const [field, prop] of properties.children) {
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
