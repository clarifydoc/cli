import type {
  ClassInfo,
  EntityRelation,
  PropertyInfo,
  RouteInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { stripAngleGroups } from "../shared/path-utils.js";

/**
 * Prisma schema (`schema.prisma`) extraction. Prisma is its own file format —
 * not embedded in a general-purpose language — so it gets a dedicated regex
 * plugin (NOT an `EntityExtractor` subclass; multiline-aware parsing is
 * implemented locally below). `model` blocks become entity `ClassInfo`s
 * (scalar/enum fields as columns, related model names on `implements`), `enum`
 * blocks become enum `ClassInfo`s, and `extractPrismaRelations` emits the rich
 * relation edges with cardinality + foreign-key resolved from
 * `@relation(fields: [...], references: [...], name: "...")`.
 *
 * Multiline handling: because attributes are frequently broken onto their own
 * lines for readability (`@default(...)` / `@db.Uuid` / `@relation(...)` on
 * separate physical lines), the parser first collapses each model/enum body
 * into *logical* field statements using bracket-balanced accumulation. A field
 * statement starts on an identifier line and absorbs continuation lines (those
 * beginning with `@`, or while bracket depth is unbalanced) until the next
 * field begins or the block closes.
 */

/** Prisma scalar field types — everything else that is Capitalised is a model/enum. */
const PRISMA_SCALARS = new Set([
  "String", "Boolean", "Int", "BigInt", "Float", "Decimal",
  "DateTime", "Json", "Bytes", "Unsupported",
]);

interface PrismaField {
  /** Prisma field name (== property name; DB column captured separately). */
  name: string;
  /** Type with `[]` and `?` stripped, generic args removed (e.g. "String", "User"). */
  baseType: string;
  isArray: boolean;
  isOptional: boolean;
  /** All columns from `@relation(fields: [...])` (composite FKs preserved). */
  relationFks: string[];
  /** Columns from `@relation(references: [...])`. */
  relationRefs: string[];
  /** Named relation from `@relation(name: "...")` / first positional arg. */
  relationName: string | null;
  /** Whether the field carries an explicit `@relation(...)` attribute. */
  hasRelationAttr: boolean;
  /** True when `@id` (single-field primary key). */
  isId: boolean;
  /** True when `@unique`. */
  isUnique: boolean;
  /** True when `@index`. */
  isIndexed: boolean;
  /** DB column name from `@map("...")`, else null. */
  dbName: string | null;
  /** Native DB type from `@db.Xxx`, else null (e.g. "Uuid", "VarChar(255)"). */
  dbType: string | null;
  /** Argument of `Unsupported("...")`, else null. */
  unsupportedType: string | null;
}

interface PrismaModel {
  name: string;
  line: number; // 1-based
  endLine: number;
  fields: PrismaField[];
  /** DB table name from model-level `@@map("...")`, else null. */
  dbTable: string | null;
  /** Composite primary key columns from `@@id([...])`, else []. */
  primaryKey: string[];
  /** Each `@@unique([...])` constraint as a column list. */
  uniqueConstraints: string[][];
}

interface PrismaEnumMember {
  name: string;
  /** DB value name from member-level `@map("...")`, else null. */
  dbName: string | null;
}

interface PrismaEnum {
  name: string;
  line: number;
  endLine: number;
  members: PrismaEnumMember[];
}

// ─── Multiline-aware primitives (local; not the base-class helpers) ──────────

/** Net bracket-depth change for `()[]{}` on a line, ignoring string literals. */
function bracketDelta(line: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/** Index of the bracket matching the opener at `openIdx` (string-aware). */
function matchBracket(s: string, openIdx: number): number {
  const open = s[openIdx]!;
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : "";
  if (!close) return -1;
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Strip `//` line comments (outside strings) and single-line `/* ... *​/` block
 * comments from a line.
 */
function stripLineComment(line: string): string {
  let s = line.replace(/\/\*.*?\*\//g, "");
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && s[i + 1] === "/") return s.slice(0, i);
    // Prisma triple-slash doc comments are also `//`-prefixed, handled above.
  }
  return s;
}

/**
 * Remove multiline `/* ... *​/` block comments from the whole source, replacing
 * removed content with blank lines so line numbers stay stable.
 */
function stripBlockComments(lines: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close < 0) { out.push(""); continue; }
      line = line.slice(close + 2);
      inBlock = false;
    }
    // Remove fully-closed inline blocks, then detect an unterminated opener.
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open >= 0) {
      line = line.slice(0, open);
      inBlock = true;
    }
    out.push(line);
  }
  return out;
}

/** Find the line index (0-based) of the closing brace for a block opened on `startIdx`. */
function findBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let seenOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    // Brace counting is string-aware via bracketDelta-style scanning.
    const line = lines[i]!;
    let quote = "";
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]!;
      if (quote) {
        if (ch === "\\") { k++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") { depth++; seenOpen = true; }
      else if (ch === "}") { depth--; if (seenOpen && depth <= 0) return i; }
    }
  }
  // Malformed / unterminated block: truncate at a safe bound rather than throw.
  return Math.min(startIdx + 500, lines.length - 1);
}

/**
 * Collapse the physical lines of a block body into balanced *logical*
 * statements. Each statement starts on a non-empty line and absorbs
 * continuation lines either while bracket depth is unbalanced, or while the
 * next line begins with `@` (an attribute broken onto its own line). Returns
 * `{ text, line }` with `line` the 0-based index (within `bodyLines`) of the
 * statement's first physical line.
 */
function logicalStatements(bodyLines: string[]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf = "";
  let startIdx = -1;
  let depth = 0;
  const flush = () => {
    if (startIdx !== -1) {
      out.push({ text: buf, line: startIdx });
      buf = "";
      startIdx = -1;
      depth = 0;
    }
  };
  for (let i = 0; i < bodyLines.length; i++) {
    const cleaned = stripLineComment(bodyLines[i] ?? "");
    const trimmed = cleaned.trim();
    if (startIdx === -1) {
      if (trimmed === "") continue;
      startIdx = i;
      buf = cleaned;
      depth = bracketDelta(cleaned);
    } else {
      // If brackets are balanced but the next non-empty line is a field-level
      // attribute continuation (`@...` but NOT a model-level `@@...`), keep
      // accumulating onto the current statement. `@@id`/`@@unique`/`@@map` are
      // standalone model-level statements and must never be merged into a field.
      if (depth <= 0 && trimmed.startsWith("@") && !trimmed.startsWith("@@")) {
        buf += " " + trimmed;
        depth += bracketDelta(cleaned);
      } else if (depth > 0) {
        buf += " " + trimmed;
        depth += bracketDelta(cleaned);
      } else {
        // Balanced and the new line is a fresh statement → flush, then restart.
        flush();
        if (trimmed === "") continue;
        startIdx = i;
        buf = cleaned;
        depth = bracketDelta(cleaned);
      }
    }
    if (depth < 0) depth = 0;
  }
  flush();
  return out;
}

// ─── Attribute parsing helpers ───────────────────────────────────────────────

/** Extract the bracketed list following `key:` inside an attribute body (e.g. `fields: [a, b]`). */
function parseAttrList(attrBody: string, key: string): string[] {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\[`);
  const m = attrBody.match(re);
  if (!m || m.index === undefined) return [];
  const openIdx = attrBody.indexOf("[", m.index);
  if (openIdx < 0) return [];
  const closeIdx = matchBracket(attrBody, openIdx);
  if (closeIdx < 0) return [];
  return attrBody
    .slice(openIdx + 1, closeIdx)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Extract a quoted string value for `key:` inside an attribute body (e.g. `name: "Author"`). */
function parseAttrString(attrBody: string, key: string): string | null {
  const re = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`);
  const m = attrBody.match(re);
  return m ? m[1]! : null;
}

/** Read the balanced `(...)` arguments of an attribute named `attrName` in `rest`. */
function attrArgs(rest: string, attrName: string): string | null {
  const re = new RegExp(`@${attrName}\\s*\\(`);
  const m = rest.match(re);
  if (!m || m.index === undefined) return null;
  const openIdx = rest.indexOf("(", m.index);
  if (openIdx < 0) return null;
  const closeIdx = matchBracket(rest, openIdx);
  if (closeIdx < 0) return null;
  return rest.slice(openIdx + 1, closeIdx);
}

// ─── Field / model / enum parsing ─────────────────────────────────────────────

/** Parse a single logical field statement (`name Type[]? @attrs...`) into a PrismaField. */
function parseField(stmt: string): PrismaField | null {
  // <name> <Type>[]? <rest of attributes...>
  const fm = stmt.match(/^\s*(\w+)\s+([^\s@]+)(.*)$/);
  if (!fm) return null;
  const name = fm[1]!;
  let rawType = fm[2]!;
  const rest = fm[3] ?? "";

  // Capture Unsupported("DBTYPE") before stripping decorations.
  let unsupportedType: string | null = null;
  const unsupportedMatch = rawType.match(/^Unsupported\(\s*["'`]([^"'`]*)["'`]\s*\)/);
  if (unsupportedMatch) {
    unsupportedType = unsupportedMatch[1]!;
    rawType = "Unsupported";
  }

  const isArray = /\[\]/.test(rawType);
  const isOptional = /\?/.test(rawType);
  // Strip array/optional markers, generic args (e.g. Json<T>), and parens.
  let baseType = stripAngleGroups(rawType.replace(/\[\]/g, "").replace(/\?/g, ""))
    .replace(/\([^)]*\)/g, "")
    .trim();

  // @relation(...) — capture fields, references, and named relation.
  const relationBody = attrArgs(rest, "relation");
  let relationFks: string[] = [];
  let relationRefs: string[] = [];
  let relationName: string | null = null;
  const hasRelationAttr = relationBody !== null;
  if (relationBody !== null) {
    relationFks = parseAttrList(relationBody, "fields");
    relationRefs = parseAttrList(relationBody, "references");
    relationName = parseAttrString(relationBody, "name");
    if (relationName === null) {
      // First positional arg can be the relation name: @relation("Author", fields: [...]).
      const pos = relationBody.match(/^\s*["'`]([^"'`]*)["'`]/);
      if (pos) relationName = pos[1]!;
    }
  }

  // @map("col") — database column name (property name stays `name`).
  const mapBody = attrArgs(rest, "map");
  let dbName: string | null = null;
  if (mapBody !== null) {
    const mm = mapBody.match(/["'`]([^"'`]*)["'`]/);
    if (mm) dbName = mm[1]!;
  }

  // @db.Xxx native DB type (e.g. @db.Uuid, @db.VarChar(255)).
  const dbMatch = rest.match(/@db\.([A-Za-z_]\w*(?:\([^)]*\))?)/);
  const dbType = dbMatch ? dbMatch[1]! : null;

  const isId = /@id\b/.test(rest);
  const isUnique = /@unique\b/.test(rest);
  const isIndexed = /@index\b/.test(rest);

  return {
    name,
    baseType,
    isArray,
    isOptional,
    relationFks,
    relationRefs,
    relationName,
    hasRelationAttr,
    isId,
    isUnique,
    isIndexed,
    dbName,
    dbType,
    unsupportedType,
  };
}

function parseModels(lines: string[]): PrismaModel[] {
  const models: PrismaModel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = stripLineComment(lines[i]!).match(/^\s*model\s+(\w+)\s*\{/);
    if (!m) continue;
    try {
      const endIdx = findBlockEnd(lines, i);
      // Body excludes the opening line's text after `{` only if a field shares
      // that line; handle inline single-line models by slicing inner content.
      const body = lines.slice(i, endIdx + 1);
      const inner = sliceBlockInner(body);
      const fields: PrismaField[] = [];
      let dbTable: string | null = null;
      const primaryKey: string[] = [];
      const uniqueConstraints: string[][] = [];

      for (const stmt of logicalStatements(inner)) {
        const text = stmt.text.trim();
        if (!text || text === "}" || text === "{") continue;

        // Model-level attributes (@@id, @@unique, @@map, @@index).
        if (text.startsWith("@@")) {
          if (/^@@id\b/.test(text)) {
            const body2 = attrArgs(text.replace(/^@@/, "@"), "id");
            if (body2 !== null) {
              const inner2 = body2.indexOf("[") >= 0
                ? body2.slice(body2.indexOf("[") + 1, matchBracket(body2, body2.indexOf("[")))
                : body2;
              for (const c of inner2.split(",").map((s) => s.trim()).filter(Boolean)) {
                primaryKey.push(c.replace(/[\[\]]/g, ""));
              }
            }
          } else if (/^@@unique\b/.test(text)) {
            const cols = parseAttrList(text, "fields");
            if (cols.length) {
              uniqueConstraints.push(cols);
            } else {
              // @@unique([a, b]) positional form.
              const open = text.indexOf("[");
              if (open >= 0) {
                const close = matchBracket(text, open);
                if (close >= 0) {
                  uniqueConstraints.push(
                    text.slice(open + 1, close).split(",").map((s) => s.trim()).filter(Boolean),
                  );
                }
              }
            }
          } else if (/^@@map\b/.test(text)) {
            const mm = text.match(/@@map\(\s*["'`]([^"'`]*)["'`]/);
            if (mm) dbTable = mm[1]!;
          }
          continue;
        }

        const field = parseField(text);
        if (field) fields.push(field);
      }

      models.push({
        name: m[1]!,
        line: i + 1,
        endLine: endIdx + 1,
        fields,
        dbTable,
        primaryKey,
        uniqueConstraints,
      });
      i = endIdx; // skip past the block we just consumed
    } catch {
      // Never throw on a malformed block — skip it and continue.
      continue;
    }
  }
  return models;
}

function parseEnums(lines: string[]): PrismaEnum[] {
  const enums: PrismaEnum[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = stripLineComment(lines[i]!).match(/^\s*enum\s+(\w+)\s*\{/);
    if (!m) continue;
    try {
      const endIdx = findBlockEnd(lines, i);
      const body = lines.slice(i, endIdx + 1);
      const inner = sliceBlockInner(body);
      const members: PrismaEnumMember[] = [];
      for (const stmt of logicalStatements(inner)) {
        const text = stmt.text.trim();
        if (!text || text === "}" || text === "{" || text.startsWith("@@")) continue;
        const vm = text.match(/^(\w+)/);
        if (!vm) continue;
        // Member-level @map("...") captures the DB enum value.
        const mapBody = attrArgs(text, "map");
        let dbName: string | null = null;
        if (mapBody !== null) {
          const mm = mapBody.match(/["'`]([^"'`]*)["'`]/);
          if (mm) dbName = mm[1]!;
        }
        members.push({ name: vm[1]!, dbName });
      }
      enums.push({ name: m[1]!, line: i + 1, endLine: endIdx + 1, members });
      i = endIdx;
    } catch {
      continue;
    }
  }
  return enums;
}

/**
 * Given the physical lines of a `name { ... }` block (first line has the `{`,
 * last line has the closing `}`), return only the inner body lines. Handles
 * single-line inline blocks (`model X { id Int @id }`) by extracting the slice
 * between the first `{` and its matching `}`.
 */
function sliceBlockInner(blockLines: string[]): string[] {
  if (blockLines.length === 0) return [];
  const joined = blockLines.join("\n");
  const open = joined.indexOf("{");
  if (open < 0) return blockLines.slice(1, -1);
  const close = matchBracket(joined, open);
  if (close < 0) return blockLines.slice(1);
  const innerText = joined.slice(open + 1, close);
  return innerText.split("\n");
}

function column(name: string, type: string | null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: false };
}

/** Build entity + enum ClassInfos from a Prisma schema. */
export function extractPrismaModels(lines: string[]): ClassInfo[] {
  // Pre-process: drop multiline block comments so brace/field parsing is robust.
  const src = stripBlockComments(lines);
  const models = parseModels(src);
  const enums = parseEnums(src);
  const modelNames = new Set(models.map((m) => m.name));
  const classes: ClassInfo[] = [];

  for (const model of models) {
    const properties: PropertyInfo[] = [];
    const implementsList: string[] = [];
    // Extra decorators carry DB-schema fidelity that PropertyInfo cannot hold.
    const extraDecorators: string[] = ["entity", "prisma"];
    if (model.dbTable) extraDecorators.push(`@@map("${model.dbTable}")`);
    if (model.primaryKey.length) extraDecorators.push(`@@id([${model.primaryKey.join(", ")}])`);
    for (const uc of model.uniqueConstraints) {
      extraDecorators.push(`@@unique([${uc.join(", ")}])`);
    }

    for (const f of model.fields) {
      // A relation field's base type must be a declared model and not a scalar
      // (guards against the rare case of a model named like a scalar token).
      if (modelNames.has(f.baseType) && !PRISMA_SCALARS.has(f.baseType)) {
        // Relation field → record related model name (not a column).
        if (!implementsList.includes(f.baseType)) implementsList.push(f.baseType);
      } else {
        // Scalar / enum-typed field → column. Property name stays the Prisma
        // field name; DB-level fidelity (@map, @db, Unsupported, constraints)
        // is encoded into the type string so downstream DB analysis can read it.
        let type = f.baseType;
        if (f.unsupportedType) {
          type = `Unsupported("${f.unsupportedType}")`;
        }
        const annotations: string[] = [];
        if (f.dbType) annotations.push(`@db.${f.dbType}`);
        if (f.dbName) annotations.push(`@map("${f.dbName}")`);
        if (f.isId) annotations.push("@id");
        if (f.isUnique) annotations.push("@unique");
        if (f.isIndexed) annotations.push("@index");
        if (f.isArray) type += "[]";
        if (f.isOptional) type += "?";
        if (annotations.length) type += " " + annotations.join(" ");
        // Enum-typed columns keep the enum name as their type (baseType).
        properties.push(column(f.name, type));
      }
    }

    classes.push({
      name: model.name,
      extends: null,
      implements: implementsList,
      decorators: extraDecorators,
      methods: [],
      properties,
      isExported: true,
      line: model.line,
      endLine: model.endLine,
    });
  }

  for (const e of enums) {
    classes.push({
      name: e.name,
      extends: null,
      implements: [],
      decorators: ["enum", "prisma"],
      methods: [],
      // Encode member @map DB value into the type slot when present.
      properties: e.members.map((member) =>
        column(member.name, member.dbName ? `@map("${member.dbName}")` : null),
      ),
      isExported: true,
      line: e.line,
      endLine: e.endLine,
    });
  }

  return classes;
}

/**
 * Build the rich relation edges between Prisma models.
 *
 * Two-sided resolution:
 *  - Explicit FK side (`@relation(fields: [...])`) → many-to-one (or one-to-one
 *    when the field is `@unique`), confidence EXTRACTED.
 *  - Array side without FK → one-to-many (the inverse owns the FK), unless both
 *    sides are arrays of each other → implicit many-to-many with a generated
 *    `_AToB` join table (alphabetical), confidence EXTRACTED.
 *  - Named relations (`@relation(name: "...")`) disambiguate multiple relations
 *    between the same two models and drive inverse-field matching.
 */
export function extractPrismaRelations(lines: string[]): EntityRelation[] {
  const src = stripBlockComments(lines);
  const models = parseModels(src);
  const byName = new Map(models.map((m) => [m.name, m]));
  const relations: EntityRelation[] = [];

  // Index relation fields per (model → target) and by relation name so we can
  // resolve inverse fields and detect implicit many-to-many pairs.
  const relationFields: Array<{ model: PrismaModel; field: PrismaField }> = [];
  for (const model of models) {
    for (const f of model.fields) {
      // Only genuine associations: base type is a declared model, not a scalar.
      if (byName.has(f.baseType) && !PRISMA_SCALARS.has(f.baseType)) {
        relationFields.push({ model, field: f });
      }
    }
  }

  /** Find the inverse field on `target` pointing back to `fromModel`. */
  function findInverse(
    fromModel: PrismaModel,
    target: PrismaModel,
    relationName: string | null,
    selfFieldName: string,
  ): PrismaField | null {
    // On a self-relation the field can match itself; never pair a field to
    // itself, so drop the self field from the candidate set up front.
    const isSelf = fromModel.name === target.name;
    const candidates = target.fields.filter(
      (tf) => tf.baseType === fromModel.name && !(isSelf && tf.name === selfFieldName),
    );
    if (candidates.length === 0) return null;
    // Disambiguate by named relation when present on either side.
    if (relationName) {
      const named = candidates.find((c) => c.relationName === relationName);
      if (named) return named;
    }
    if (candidates.length === 1) return candidates[0]!;
    // Multiple candidates and no name match → ambiguous; pick the first.
    return candidates[0]!;
  }

  // Track emitted implicit m2m pairs so each is emitted once per side correctly.
  for (const { model, field: f } of relationFields) {
    try {
      const target = byName.get(f.baseType)!;
      const relationName = f.relationName;
      const inverse = findInverse(model, target, relationName, f.name);

      // ── Implicit many-to-many: both sides are arrays with no FK fields. ──
      if (f.isArray && inverse?.isArray && f.relationFks.length === 0 && inverse.relationFks.length === 0) {
        // Prisma generates `_AToB` (the two model names sorted alphabetically),
        // unless an explicit relation name overrides it (`_RelationName`).
        let joinTable: string;
        if (relationName) {
          joinTable = `_${relationName}`;
        } else {
          const [a, b] = [model.name, f.baseType].sort();
          joinTable = `_${a}To${b}`;
        }
        relations.push({
          fromEntity: model.name,
          fromField: f.name,
          toEntity: f.baseType,
          cardinality: "many-to-many",
          inverseField: inverse.name,
          joinTable,
          optional: f.isOptional,
          orm: "prisma",
          confidence: "EXTRACTED",
        });
        continue;
      }

      // ── Determine cardinality for explicit / 1-N relations. ──
      let cardinality: EntityRelation["cardinality"];
      let confidence: EntityRelation["confidence"] = "EXTRACTED";
      if (f.isArray) {
        // List side: the inverse owns the FK → this side is one-to-many.
        cardinality = "one-to-many";
      } else if (f.hasRelationAttr && f.relationFks.length > 0) {
        // Owning side with explicit FK. one-to-one if FK column is @unique,
        // else many-to-one. Detect @unique on the FK scalar field.
        const fkUnique = f.relationFks.some((fk) =>
          model.fields.some((mf) => mf.name === fk && mf.isUnique),
        );
        // one-to-one when the FK column is unique, or the inverse is also a
        // singular relation field; otherwise the owning side is many-to-one.
        const oneToOne = fkUnique || (inverse !== null && !inverse.isArray);
        cardinality = oneToOne ? "one-to-one" : "many-to-one";
      } else {
        // Singular relation field without explicit FK attribute. Infer from the
        // inverse: array inverse → many-to-one, scalar inverse → one-to-one.
        if (inverse?.isArray) cardinality = "many-to-one";
        else cardinality = "one-to-one";
        confidence = "INFERRED";
      }

      relations.push({
        fromEntity: model.name,
        fromField: f.name,
        toEntity: f.baseType,
        cardinality,
        foreignKey: f.relationFks.length ? f.relationFks.join(", ") : null,
        inverseField: inverse ? inverse.name : null,
        optional: f.isOptional,
        orm: "prisma",
        confidence,
      });
    } catch {
      // Skip any relation that fails to resolve cleanly; never throw.
      continue;
    }
  }

  return relations;
}

export const prismaSpec: RegexLangSpec = {
  language: "prisma",
  extensions: [".prisma"],
  blockStyle: "brace",
  lineCommentPrefixes: ["//"],
  functionPatterns: [],
  classPatterns: [],
  importPatterns: [],
  extractClasses: (lines) => extractPrismaModels(lines),
  extractEntityRelations: (lines) => extractPrismaRelations(lines),
  extractRoutes: (_lines, _classes): RouteInfo[] => [],
};
