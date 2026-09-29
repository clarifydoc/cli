import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, type GuardAttr } from "../../shared/route-metadata.js";
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
 * The contract is the route's attribute layer, filled with nothing `inferred`:
 * an operation's `<input message="tns:X"/>` names a `<message>` whose `<part>`s
 * become body-bound `params` (rpc style: `part type="xsd:int"`; document
 * style: `part element="tns:Req"`, whose top-level `<xsd:element>` with an
 * inline `complexType` is itself emitted as an entity so the body schema
 * resolves). Element `minOccurs="0"` / `nillable="true"` make a property
 * optional (every other element is `isRequired`), `maxOccurs="unbounded"` is
 * spelled `Item[]` in the type text, and a WS-Policy / WS-Security element
 * anywhere in the document puts a `ws-security` scheme on every operation
 * (inherited — the binding, not the operation, declares it).
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

/** `<message name="X"><part name="p" type|element="…"/></message>` → X → parts. */
function parseMessages(tags: XmlTag[]): Map<string, RouteParamInfo[]> {
  const out = new Map<string, RouteParamInfo[]>();
  let current: RouteParamInfo[] | null = null;
  for (const tag of tags) {
    const name = localName(tag.name);
    if (name === "message") {
      if (tag.close || tag.selfClose) { current = null; continue; }
      const msgName = attrOf(tag.attrs, "name");
      current = msgName ? [] : null;
      if (msgName && current) out.set(msgName, current);
      continue;
    }
    if (!current || tag.close || name !== "part") continue;
    const partName = attrOf(tag.attrs, "name");
    if (!partName) continue;
    const type = stripNsPrefix(attrOf(tag.attrs, "type") ?? attrOf(tag.attrs, "element"));
    current.push({ name: partName, type, binding: "body" });
  }
  return out;
}

/** WS-Policy / WS-Security markup anywhere in the document → one inherited guard. */
function securityGuards(tags: XmlTag[]): GuardAttr[] {
  const marker = tags.find((t) => !t.close && (
    /^(wsse|sp|wsu):/i.test(t.name)
    || (localName(t.name) === "Policy" && /^wsp:/i.test(t.name))
    || localName(t.name) === "PolicyReference"
  ));
  if (!marker) return [];
  return [{ text: marker.name.replace(/^wsu:/i, "wsse:"), schemes: ["ws-security"] }];
}

export function extractWsdlRoutes(lines: string[]): RouteInfo[] {
  const tags = tagsOf(lines);
  const messages = parseMessages(tags);
  const inheritedGuards = securityGuards(tags);
  const routes: RouteInfo[] = [];
  let inPortType = false;
  let current: RouteInfo | null = null;
  const seen = new Set<string>();
  for (const tag of tags) {
    const name = localName(tag.name);
    // portType (WSDL 1.1) / interface (WSDL 2.0) both hold the operations.
    if (name === "portType" || name === "interface") {
      inPortType = !tag.close && !tag.selfClose ? true : tag.close ? false : inPortType;
      current = null;
      continue;
    }
    if (!inPortType) continue;
    if (name === "operation") {
      if (tag.close) { current = null; continue; }
      const opName = attrOf(tag.attrs, "name");
      if (!opName || seen.has(opName)) { current = null; continue; }
      seen.add(opName);
      current = {
        path: `/${opName}`,
        httpMethod: null,
        kind: "api",
        handler: opName,
        calls: [],
        middleware: [],
        line: tag.line,
      };
      applyRouteMeta(current, { inheritedGuards });
      routes.push(current);
      if (tag.selfClose) current = null;
      continue;
    }
    if (!current || tag.close || name !== "input") continue;
    // WSDL 1.1: `<input message="tns:X"/>`; WSDL 2.0: `<input element="tns:Req"/>`.
    const message = stripNsPrefix(attrOf(tag.attrs, "message"));
    const element = stripNsPrefix(attrOf(tag.attrs, "element"));
    const params = message ? (messages.get(message) ?? []) : element ? [{ name: element, type: element, binding: "body" as const }] : [];
    if (params.length > 0) applyRouteMeta(current, { params });
  }
  return routes;
}

// ─── Entities: XSD complexType → data-model nodes ──────────────────────────────

interface XsdType {
  name: string;
  line: number;
  elements: Array<{ name: string; type: string | null; list: boolean; optional: boolean; nillable: boolean }>;
}

/**
 * Named `complexType`s, plus document-style wrappers — a top-level
 * `<xsd:element name="Req">` whose type is an inline anonymous `complexType`
 * (the shape every doc/literal-wrapped operation takes) is emitted under the
 * element's name. Nested anonymous types are skipped without losing the
 * enclosing type's remaining elements.
 */
function parseComplexTypes(tags: XmlTag[]): XsdType[] {
  const out: XsdType[] = [];
  const stack: Array<XsdType | null> = [];
  let elementDepth = 0; // open <element> tags — 0 means "top level of the schema"
  let wrapperName: string | null = null; // a top-level element awaiting its inline complexType
  const current = () => (stack.length > 0 ? stack[stack.length - 1]! : null);
  for (const tag of tags) {
    const name = localName(tag.name);
    if (name === "complexType") {
      if (tag.close) { stack.pop(); continue; }
      const typeName = attrOf(tag.attrs, "name") ?? (stack.length === 0 ? wrapperName : null);
      const type = typeName ? { name: typeName, line: tag.line, elements: [] } : null;
      if (type) out.push(type);
      if (!tag.selfClose) stack.push(type);
      wrapperName = null;
      continue;
    }
    if (name !== "element") continue;
    if (tag.close) { elementDepth = Math.max(0, elementDepth - 1); continue; }
    const elName = attrOf(tag.attrs, "name");
    const cur = current();
    if (cur) {
      if (elName) {
        const type = stripNsPrefix(attrOf(tag.attrs, "type"));
        const maxOccurs = attrOf(tag.attrs, "maxOccurs");
        const list = maxOccurs === "unbounded" || (maxOccurs != null && Number(maxOccurs) > 1);
        const optional = attrOf(tag.attrs, "minOccurs") === "0";
        const nillable = attrOf(tag.attrs, "nillable") === "true";
        cur.elements.push({ name: elName, type, list, optional, nillable });
      }
    } else if (stack.length === 0 && elementDepth === 0 && elName && !attrOf(tag.attrs, "type") && !tag.selfClose) {
      wrapperName = elName;
    }
    if (!tag.selfClose) elementDepth++;
  }
  return out;
}

export function extractWsdlEntities(lines: string[]): ClassInfo[] {
  const types = parseComplexTypes(tagsOf(lines));
  return types.map((t) => {
    const properties: PropertyInfo[] = t.elements.map((e) => {
      let type = e.type ? (e.list ? `${e.type}[]` : e.type) : null;
      if (type && e.nillable) type += "?";
      const p: PropertyInfo = {
        name: e.name,
        type,
        visibility: "public",
        isStatic: false,
        isReadonly: false,
      };
      if (!e.optional && !e.nillable) p.isRequired = true;
      return p;
    });
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
