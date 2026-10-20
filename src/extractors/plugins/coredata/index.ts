import type { ClassInfo, EntityRelation, PropertyInfo, RouteInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * A Core Data model (`<Model>.xcdatamodel/contents`): each `<entity>` an
 * entity class — named by its `representedClassName` (the Swift or
 * Objective-C class the code uses), extending its `parentEntity` — with its
 * `<attribute>`s as columns, and each `<relationship>` an edge with the
 * cardinality its own `toMany` and its inverse's state.
 *
 *   <entity name="Folder" representedClassName="Folder" syncable="YES">
 *     <attribute name="name" attributeType="String"/>
 *     <relationship name="notes" toMany="YES" destinationEntity="ArchivedNote" inverseName="folder" inverseEntity="ArchivedNote"/>
 *   </entity>
 */

interface Element {
  tag: "entity" | "attribute" | "relationship";
  attrs: Map<string, string>;
  line: number;
}

const ELEMENT_RE = /<(entity|attribute|relationship)\b([^>]*?)\/?>|<\/entity>/g;
const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

interface ModelEntity {
  name: string;
  className: string;
  parent: string | null;
  line: number;
  endLine: number;
  attributes: Array<{ name: string; type: string; optional: boolean }>;
  relationships: Array<{ name: string; toMany: boolean; optional: boolean; destination: string; inverse: string | null }>;
}

function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function parseModel(lines: string[]): ModelEntity[] {
  const text = lines.join("\n");
  const lineAt: number[] = [];
  for (let i = 0, line = 1; i < text.length; i++) {
    lineAt[i] = line;
    if (text[i] === "\n") line++;
  }
  const entities: ModelEntity[] = [];
  let open: ModelEntity | null = null;
  for (const m of text.matchAll(ELEMENT_RE)) {
    const line = lineAt[m.index!] ?? 1;
    if (!m[1]) {
      if (open) open.endLine = line;
      open = null;
      continue;
    }
    const el: Element = { tag: m[1] as Element["tag"], attrs: new Map([...m[2]!.matchAll(ATTR_RE)].map((a) => [a[1]!, unescape(a[2]!)])), line };
    const name = el.attrs.get("name");
    if (!name) continue;
    if (el.tag === "entity") {
      const entity: ModelEntity = { name, className: el.attrs.get("representedClassName") || name, parent: el.attrs.get("parentEntity") ?? null, line, endLine: line, attributes: [], relationships: [] };
      entities.push(entity);
      open = m[0].endsWith("/>") ? null : entity;
    } else if (open && el.tag === "attribute") {
      if (el.attrs.get("transient") === "YES") continue;
      open.attributes.push({ name, type: el.attrs.get("customClassName") || el.attrs.get("attributeType") || "Undefined", optional: el.attrs.get("optional") === "YES" });
    } else if (open && el.tag === "relationship") {
      const destination = el.attrs.get("destinationEntity");
      if (!destination) continue;
      open.relationships.push({ name, toMany: el.attrs.get("toMany") === "YES", optional: el.attrs.get("optional") === "YES", destination, inverse: el.attrs.get("inverseName") ?? null });
    }
  }
  return entities;
}

const property = (name: string, type: string): PropertyInfo => ({ name, type, visibility: "public", isStatic: false, isReadonly: false });

export function extractCoreDataEntities(lines: string[]): ClassInfo[] {
  const entities = parseModel(lines);
  const classOf = new Map(entities.map((e) => [e.name, e.className]));
  return entities.map((e) => ({
    name: e.className,
    ...(e.className !== e.name ? { tableName: e.name } : {}),
    extends: e.parent ? (classOf.get(e.parent) ?? e.parent) : null,
    implements: [...new Set(e.relationships.map((r) => classOf.get(r.destination) ?? r.destination))],
    decorators: ["entity", "coredata"],
    methods: [],
    properties: e.attributes.map((a) => property(a.name, `${a.type}${a.optional ? "?" : ""}`)),
    isExported: true,
    line: e.line,
    endLine: e.endLine,
  }));
}

export function extractCoreDataRelations(lines: string[]): EntityRelation[] {
  const entities = parseModel(lines);
  const byName = new Map(entities.map((e) => [e.name, e]));
  const out: EntityRelation[] = [];
  for (const e of entities) {
    for (const r of e.relationships) {
      const target = byName.get(r.destination);
      const inverse = r.inverse ? target?.relationships.find((x) => x.name === r.inverse) : undefined;
      const cardinality: EntityRelation["cardinality"] = r.toMany
        ? inverse?.toMany ? "many-to-many" : "one-to-many"
        : inverse && !inverse.toMany ? "one-to-one" : "many-to-one";
      out.push({
        fromEntity: e.className,
        fromField: r.name,
        toEntity: target?.className ?? r.destination,
        cardinality,
        inverseField: r.inverse,
        optional: r.optional,
        orm: "coredata",
        confidence: "EXTRACTED",
      });
    }
  }
  return out;
}

export const coredataSpec: RegexLangSpec = {
  language: "coredata",
  extensions: [],
  blockStyle: "brace",
  lineCommentPrefixes: [],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  extractClasses: (lines) => extractCoreDataEntities(lines),
  extractEntityRelations: (lines) => extractCoreDataRelations(lines),
  extractRoutes: (): RouteInfo[] => [],
};
