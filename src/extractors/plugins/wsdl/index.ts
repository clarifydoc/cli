import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { attrOf, localName, scanTags, type XmlTag } from "../shared/xml-scan.js";

/**
 * WSDL service contracts (`.wsdl`) — the SOAP world's contract-first spec.
 * Legacy integration landscapes (the reverse-doc audience) describe their API
 * surface here, and the implementing Java/C# service class exposes one method
 * per operation named after it, so the operations join to their handlers by
 * name exactly like OpenAPI operationIds:
 *
 *   <portType name="UserService">
 *     <operation name="GetUser"/>       → route /GetUser   (handler: GetUser)
 *     <operation name="ListUsers"/>     → route /ListUsers (handler: ListUsers)
 *   </portType>
 *
 * The embedded XSD `<types>` block carries the data model:
 *
 *   <xsd:complexType name="User">       → entity "User"
 *     <xsd:element name="id" type="xsd:int"/>
 *     <xsd:element name="orders" type="tns:Order" maxOccurs="unbounded"/>
 *                                        → User → Order (one-to-many)
 *   </xsd:complexType>
 *
 * Claimed by extension; a `.wsdl` file is unambiguous, so no content sniff.
 */

// ─── XSD scalar type names (namespace prefix already stripped) ─────────────────
const XSD_SCALARS = new Set([
  "string", "int", "integer", "long", "short", "byte", "decimal", "float", "double",
  "boolean", "date", "time", "dateTime", "duration", "base64Binary", "hexBinary",
  "anyURI", "QName", "normalizedString", "token", "unsignedInt", "unsignedLong",
  "positiveInteger", "nonNegativeInteger", "any", "anyType",
]);

/** Strip a `tns:`/`xsd:` namespace prefix from a type reference. */
function stripNsPrefix(ref: string | null): string | null {
  if (!ref) return null;
  const local = localName(ref);
  return /^[A-Za-z_]/.test(local) ? local : null;
}

const PARSE_CACHE = new WeakMap<string[], XmlTag[]>();

function tagsOf(lines: string[]): XmlTag[] {
  let tags = PARSE_CACHE.get(lines);
  if (!tags) {
    tags = scanTags(lines.join("\n"));
    PARSE_CACHE.set(lines, tags);
  }
  return tags;
}

// ─── Routes: portType operations → api routes ──────────────────────────────────

export function extractWsdlRoutes(lines: string[]): RouteInfo[] {
  const tags = tagsOf(lines);
  const routes: RouteInfo[] = [];
  let inPortType = false;
  const seen = new Set<string>();
  for (const tag of tags) {
    const name = localName(tag.name);
    // portType (WSDL 1.1) / interface (WSDL 2.0) both hold the operations.
    if (name === "portType" || name === "interface") {
      inPortType = !tag.close && !tag.selfClose ? true : tag.close ? false : inPortType;
      continue;
    }
    if (!inPortType || tag.close || name !== "operation") continue;
    const opName = attrOf(tag.attrs, "name");
    if (!opName || seen.has(opName)) continue;
    seen.add(opName);
    routes.push({
      path: `/${opName}`,
      httpMethod: null,
      kind: "api",
      handler: opName,
      calls: [],
      middleware: [],
      line: tag.line,
    });
  }
  return routes;
}

// ─── Entities: XSD complexType → data-model nodes ──────────────────────────────

interface XsdType {
  name: string;
  line: number;
  elements: Array<{ name: string; type: string | null; list: boolean }>;
}

function parseComplexTypes(tags: XmlTag[]): XsdType[] {
  const out: XsdType[] = [];
  let current: XsdType | null = null;
  for (const tag of tags) {
    const name = localName(tag.name);
    if (name === "complexType") {
      if (tag.close) { current = null; continue; }
      const typeName = attrOf(tag.attrs, "name");
      // Anonymous inline complexTypes (no name) aren't standalone entities.
      current = typeName ? { name: typeName, line: tag.line, elements: [] } : null;
      if (current) out.push(current);
      if (tag.selfClose) current = null;
      continue;
    }
    if (!current || tag.close || name !== "element") continue;
    const elName = attrOf(tag.attrs, "name");
    if (!elName) continue;
    const type = stripNsPrefix(attrOf(tag.attrs, "type"));
    const maxOccurs = attrOf(tag.attrs, "maxOccurs");
    const list = maxOccurs === "unbounded" || (maxOccurs != null && Number(maxOccurs) > 1);
    current.elements.push({ name: elName, type, list });
  }
  return out;
}

export function extractWsdlEntities(lines: string[]): ClassInfo[] {
  const types = parseComplexTypes(tagsOf(lines));
  return types.map((t) => {
    const properties: PropertyInfo[] = t.elements.map((e) => ({
      name: e.name,
      type: e.type ? (e.list ? `[${e.type}]` : e.type) : null,
      visibility: "public",
      isStatic: false,
      isReadonly: false,
    }));
    return {
      name: t.name,
      extends: null,
      implements: [],
      decorators: ["entity", "wsdl"],
      methods: [],
      properties,
      isExported: true,
      line: t.line,
      endLine: t.line,
    };
  });
}

export function extractWsdlRelations(lines: string[], classes: ClassInfo[]): EntityRelation[] {
  const types = parseComplexTypes(tagsOf(lines));
  const known = new Set(classes.map((c) => c.name));
  const out: EntityRelation[] = [];
  for (const t of types) {
    for (const el of t.elements) {
      if (!el.type || XSD_SCALARS.has(el.type) || !known.has(el.type) || el.type === t.name) continue;
      out.push({
        fromEntity: t.name,
        fromField: el.name,
        toEntity: el.type,
        cardinality: el.list ? "one-to-many" : "many-to-one",
        orm: "wsdl",
        confidence: "EXTRACTED",
      });
    }
  }
  return out;
}

export const wsdlSpec: RegexLangSpec = {
  language: "wsdl",
  extensions: [".wsdl"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  lineCommentPrefixes: ["<!--"],
  extractRoutes: (lines) => extractWsdlRoutes(lines),
  extractClasses: (lines) => extractWsdlEntities(lines),
  extractEntityRelations: (lines, classes) => extractWsdlRelations(lines, classes),
};
