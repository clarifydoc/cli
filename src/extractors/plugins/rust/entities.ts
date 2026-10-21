import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { FileAnalysis, ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Rust ORM entity extractor for Diesel and SeaORM.
 *
 * Rust is regex-parsed by the rest of the pipeline, so structs / macros do not
 * reliably appear in `analysis.classes`. This extractor therefore scans
 * `ctx.lines` directly, but relies on the shared multiline-aware primitives
 * (`logicalLines`, `matchBracket`, `stripLineComment`, `coreType`) so that
 * constructs spanning several physical lines — multiline `#[derive(...)]`,
 * `table!` blocks with `#[cfg(...)]` predicates, nested generic column types —
 * are handled as a single logical unit rather than scanned line-by-line.
 *
 * Recognized patterns:
 *   Diesel
 *     - `table! { [#[cfg(...)]] users (id) { id -> Int4, ... } }` → entity + columns
 *     - `joinable!(posts -> users (user_id));`                    → many-to-one relation
 *     - `#[derive(...)] #[belongs_to(super::users::User)] struct Post {…}` → many-to-one
 *     - `allow_tables_to_appear_in_same_query!(a, b);`            → implicit m2m (INFERRED)
 *   SeaORM
 *     - any struct annotated `#[sea_orm(table_name = "…")]` or deriving
 *       `DeriveEntityModel` (commonly `Model`, but renamed structs are accepted)
 *       → entity + columns (Related<T> / relation-decorated fields are skipped)
 *     - `pub enum Relation { #[sea_orm(belongs_to/has_many/has_one = "…", …)] }`
 *       → cardinality relations, including `optional` and `from`/`to` FK columns
 *
 * Never throws — anything unparseable is silently skipped.
 */

/** A `{ … }` block discovered by brace tracking. */
interface BraceBlock {
  /** 0-based index of the line containing the opening `{`. */
  openLine: number;
  /** 0-based index of the line containing the matching `}` (or last line). */
  closeLine: number;
  /** Lines of the whole block, opening line through closing line (inclusive). */
  body: string[];
}

/** A SeaORM relation variant parsed out of the `Relation` enum. */
interface SeaOrmRelation {
  variant: string;
  cardinality: EntityRelation["cardinality"];
  toEntity: string;
  foreignKey: string | null;
  optional: boolean;
}

/** Marks the class a `table!` block made, with the table it declares (`diesel-table:folders`). */
const DIESEL_TABLE_DECORATOR = "diesel-table:";

export class RustEntityExtractor extends EntityExtractor {
  /**
   * A `table!` block's entity and the model struct that maps it
   * (`#[diesel(table_name = folders)] pub struct Folder`) are one entity: the
   * struct becomes it (its fields, the table's name and columns' relations
   * kept), and the class the macro made — named like the struct, so receivers
   * typed `Folder` met two classes — is dropped.
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const rust = analyses.filter((a) => a.language === "rust");
    const mapped = new Map<string, ClassInfo[]>();
    for (const a of rust) {
      for (const c of a.classes) {
        if (c.decorators.some((d) => d.startsWith(DIESEL_TABLE_DECORATOR))) continue;
        const table = c.decorators.map((d) => /^diesel\(\s*table_name\s*=\s*"?(\w+)"?\s*\)$|^table_name\s*=\s*"(\w+)"$/.exec(d)).find(Boolean);
        const name = table?.[1] ?? table?.[2];
        if (name) (mapped.get(name) ?? mapped.set(name, []).get(name)!).push(c);
      }
    }
    if (mapped.size === 0) return;
    for (const a of rust) {
      a.classes = a.classes.filter((c) => {
        const table = c.decorators.find((d) => d.startsWith(DIESEL_TABLE_DECORATOR))?.slice(DIESEL_TABLE_DECORATOR.length);
        const models = table ? mapped.get(table) : undefined;
        if (!table || !models) return true;
        for (const model of models) {
          if (!model.decorators.includes("entity")) model.decorators.push("entity", "diesel");
          if (table.toLowerCase() !== model.name.toLowerCase()) model.tableName = table;
        }
        return false;
      });
    }
  }

  readonly languages: Language[] = ["rust"];

  /** Rust uses C-style `//` (and `///` doc) line comments. */
  private static readonly COMMENT: readonly string[] = ["//"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    try {
      const lines = ctx.lines ?? [];

      this.extractDieselTables(lines, entities);
      this.extractDieselJoinables(lines, relations);
      this.extractDieselBelongsTo(lines, relations);
      this.extractDieselAllowSameQuery(lines, relations);
      this.extractSeaOrm(lines, entities, relations);
    } catch {
      // Never throw — return whatever we managed to gather.
    }

    return { entities, relations };
  }

  // ─── Diesel: table! macros ──────────────────────────────────────────────

  /**
   * Extract every `table! { … <name> (pk) { col -> Type, … } }` block.
   *
   * The table identifier no longer has to share a physical line with the
   * `table!` token: we locate `table!`, find its outer `{ … }` body, then scan
   * the body for the `<ident> (` header (which may be preceded by `#[cfg(...)]`
   * predicates on their own lines).
   */
  private extractDieselTables(lines: string[], out: ClassInfo[]): void {
    for (let i = 0; i < lines.length; i++) {
      // Note: no trailing `\b` — `table!` is followed by `!` then whitespace,
      // and there is no word boundary between `!` and a space.
      if (!/\btable!/.test(lines[i] ?? "")) continue;
      const block = this.blockFrom(lines, i);
      if (!block) continue;

      // Find the table header anywhere inside the macro body, even when cfg
      // attributes sit between `table!` and the identifier. Diesel allows both
      // `users (id) { … }` and `users { … }`, so the identifier may be followed
      // by either `(` (a primary-key list) or `{` (the column block). Skip the
      // `#[…]` attribute and `table!` lines so their tokens aren't mistaken for
      // the table name.
      const header = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|\{)/;
      let tableName: string | null = null;
      let headerOffset = -1; // index within block.body of the header line
      for (let b = 0; b < block.body.length; b++) {
        const line = this.stripLineComment(block.body[b] ?? "", RustEntityExtractor.COMMENT);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("table!")) continue;
        const hm = header.exec(trimmed);
        if (hm) {
          tableName = hm[1];
          headerOffset = b;
          break;
        }
      }
      if (!tableName) {
        i = block.closeLine; // advance past this macro regardless
        continue;
      }

      // The columns live inside the *inner* `{ … }` that follows the table
      // header (`users (id) { … }`), not the outer macro braces. Locate that
      // inner block so column parsing sees one column per logical line.
      const innerOpenAbs = this.findBraceOpen(lines, block.openLine + headerOffset);
      const innerBlock = innerOpenAbs >= 0 ? this.blockAt(lines, innerOpenAbs) : null;
      const columns = innerBlock
        ? this.parseDieselColumns(this.innerBody(innerBlock))
        : [];

      out.push(
        this.entity({
          name: this.entityName(tableName),
          orm: "diesel",
          properties: columns,
          line: i + 1,
          endLine: block.closeLine + 1,
          extraDecorators: [`${DIESEL_TABLE_DECORATOR}${tableName}`],
        }),
      );
      i = block.closeLine; // don't re-enter this block
    }
  }

  /**
   * Parse `colname -> SqlType,` lines from a `table!` body. Uses logical lines
   * so a column whose type spans physical lines (rare, but `Nullable<Array<…>>`
   * wrapped declarations) is reassembled, and routes the type through
   * `coreType` so nested generics with commas (`Map<String, Vec<i32>>`) are not
   * truncated.
   */
  private parseDieselColumns(body: string[]): PropertyInfo[] {
    const cols: PropertyInfo[] = [];
    const seen = new Set<string>();
    // Capture the full RHS up to the trailing comma; coreType handles generics.
    const colRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([^,]+(?:<[^]*?>)?[^,]*?)\s*,?\s*$/;
    for (const ll of this.logicalLines(body, { lineComment: RustEntityExtractor.COMMENT })) {
      try {
        const text = ll.text.trim();
        const m = colRe.exec(text);
        if (!m) continue;
        const name = m[1];
        if (seen.has(name)) continue;
        seen.add(name);
        // Preserve the Diesel type verbatim (Diesel uses its own type names),
        // only trimming a trailing comma; coreType would over-strip wrappers
        // like `Nullable<Text>` that are meaningful in Diesel schemas.
        const rawType = m[2].replace(/,\s*$/, "").trim();
        cols.push(this.column(name, rawType.length > 0 ? rawType : null));
      } catch {
        // Skip an unparseable column line.
      }
    }
    return cols;
  }

  // ─── Diesel: joinable!(child -> parent (fk)); ───────────────────────────

  private extractDieselJoinables(lines: string[], out: EntityRelation[]): void {
    const re =
      /\bjoinable!\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\)/;
    // joinable! is single-statement but may wrap; use logical lines to be safe.
    for (const ll of this.logicalLines(lines, { lineComment: RustEntityExtractor.COMMENT })) {
      const m = re.exec(ll.text);
      if (!m) continue;
      const child = this.entityName(m[1]);
      const parent = this.entityName(m[2]);
      const fk = m[3];
      out.push({
        fromEntity: child,
        // Use the actual FK column as the field name when it isn't a plain
        // `<parent>_id`, so foreignKey and fromField stay consistent.
        fromField: this.relationFieldFromFk(fk, parent),
        toEntity: parent,
        cardinality: "many-to-one",
        foreignKey: fk,
        orm: "diesel",
        confidence: "EXTRACTED",
      });
    }
  }

  // ─── Diesel: #[belongs_to(Parent)] on a struct ──────────────────────────

  /**
   * `#[belongs_to(super::users::User)] struct Post { … }` → Post many-to-one
   * User. The parent type may be a module path; only the final segment is the
   * entity name, and the FK is inferred from that segment (`user_id`).
   * Diesel also allows `#[belongs_to(User, foreign_key = "author_id")]`.
   */
  private extractDieselBelongsTo(lines: string[], out: EntityRelation[]): void {
    // Path-aware capture: allow `super::users::User`, `crate::User`, etc.
    const belongsRe = /#\[\s*belongs_to\s*\(\s*([A-Za-z_][A-Za-z0-9_:]*)\s*(?:,([^)]*))?\)/;
    const structRe = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/;
    const logical = this.logicalLines(lines, { lineComment: RustEntityExtractor.COMMENT });

    for (let k = 0; k < logical.length; k++) {
      const bm = belongsRe.exec(logical[k].text);
      if (!bm) continue;
      const parent = this.lastSegment(bm[1]); // strip module path → final type
      if (!parent) continue;

      // Explicit `foreign_key = "…"` inside the attribute, if present.
      let fk: string | null = null;
      const fkMatch = /foreign_key\s*=\s*"([^"]+)"/.exec(bm[2] ?? "");
      if (fkMatch) fk = fkMatch[1];

      // The struct declaration usually follows within the next few logical
      // statements (after other derives). Scan forward for the nearest struct.
      let child: string | null = null;
      for (let j = k; j < Math.min(logical.length, k + 8); j++) {
        const sm = structRe.exec(logical[j].text);
        if (sm) {
          child = sm[1];
          break;
        }
      }
      if (!child) continue;

      const inferredFk = `${this.snake(parent)}_id`;
      out.push({
        fromEntity: child,
        fromField: this.lowerFirst(parent),
        toEntity: parent,
        cardinality: "many-to-one",
        foreignKey: fk ?? inferredFk,
        orm: "diesel",
        // Explicit foreign_key is EXTRACTED; convention-derived FK is INFERRED.
        confidence: fk ? "EXTRACTED" : "INFERRED",
      });
    }
  }

  // ─── Diesel: allow_tables_to_appear_in_same_query!(a, b, …) ──────────────

  /**
   * Diesel declares implicit query compatibility (often, but not always, a
   * many-to-many pairing) via this macro. We surface each *pair* as a low-
   * confidence many-to-many so downstream analysis can see the association,
   * marked INFERRED because the macro doesn't itself prove a relation.
   */
  private extractDieselAllowSameQuery(lines: string[], out: EntityRelation[]): void {
    const re = /\ballow_tables_to_appear_in_same_query!\s*\(([^)]*)\)/;
    for (const ll of this.logicalLines(lines, { lineComment: RustEntityExtractor.COMMENT })) {
      const m = re.exec(ll.text);
      if (!m) continue;
      const tables = m[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => this.entityName(t));
      // Emit each unordered pair once.
      for (let a = 0; a < tables.length; a++) {
        for (let b = a + 1; b < tables.length; b++) {
          out.push({
            fromEntity: tables[a],
            fromField: this.lowerFirst(this.plural(tables[b])),
            toEntity: tables[b],
            cardinality: "many-to-many",
            orm: "diesel",
            confidence: "INFERRED",
          });
        }
      }
    }
  }

  // ─── SeaORM: DeriveEntityModel structs + Relation enums ──────────────────

  /**
   * SeaORM entity = any struct that either derives `DeriveEntityModel` or is
   * annotated `#[sea_orm(table_name = "…")]`. The struct is conventionally
   * named `Model`, but renamed structs (`User`, `Post`) are accepted too.
   */
  private extractSeaOrm(
    lines: string[],
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    // `decoratedMembers` groups stacked / multiline `#[…]` attributes with the
    // declaration they precede, so a multiline `#[derive(…)]` is collected in
    // full and a renamed struct is still seen with its annotations attached.
    const members = this.decoratedMembers(lines, {
      style: "hash-square",
      lineComment: RustEntityExtractor.COMMENT,
    });

    // Track the entity name so a `Relation` enum can attribute its relations to
    // the right `fromEntity` even when declared after the struct.
    let entityNameForFile: string | null = null;

    for (const member of members) {
      const decoratorText = member.decorators.join("\n");
      const decl = member.declaration;

      const structMatch = /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(decl);
      if (structMatch) {
        const isSeaOrmEntity =
          /DeriveEntityModel/.test(decoratorText) ||
          /#\[\s*sea_orm\s*\([^]*table_name/.test(decoratorText);
        if (!isSeaOrmEntity) continue;

        const tableMatch = /table_name\s*=\s*"([^"]+)"/.exec(decoratorText);
        // Prefer the declared table name; otherwise use the struct identifier
        // (handles `struct User` and non-literal table_name constants alike).
        const structName = structMatch[1];
        const name =
          tableMatch
            ? this.entityName(tableMatch[1])
            : structName === "Model"
              ? "Model"
              : this.upperFirst(structName);
        entityNameForFile = name;

        // Re-locate the struct's brace body in the raw lines for column parsing.
        // Find the struct's own line first (member.line points at the first
        // decorator), then take the inner lines between its braces so the
        // multiline-aware field parser sees one logical line per field.
        const declLine = this.findStructLine(lines, member.line);
        const openLine = this.findBraceOpen(lines, declLine);
        const block = openLine >= 0 ? this.blockAt(lines, openLine) : null;
        const columns = block ? this.parseSeaOrmFields(this.innerBody(block)) : [];

        entities.push(
          this.entity({
            name,
            orm: "sea-orm",
            properties: columns,
            line: declLine + 1,
            endLine: (block ? block.closeLine : declLine) + 1,
          }),
        );
      }
    }

    // Parse Relation enums separately (their variants carry the associations).
    for (let i = 0; i < lines.length; i++) {
      if (!/\benum\s+Relation\b/.test(lines[i] ?? "")) continue;
      const block = this.blockFrom(lines, i);
      if (!block) continue;
      const parsed = this.parseSeaOrmRelations(this.innerBody(block));
      this.emitSeaOrmRelations(parsed, entityNameForFile ?? "Model", relations);
      i = block.closeLine;
    }
  }

  /**
   * Parse `pub name: RustType,` struct fields, skipping relation-only fields:
   *   - fields preceded by a `belongs_to`/`has_many`/`has_one`/`relation` attr
   *   - fields whose type is `Related<…>` (a lazy relation marker, not a column)
   * Marks `Option<…>` columns optional and routes the type through `coreType`.
   */
  private parseSeaOrmFields(body: string[]): PropertyInfo[] {
    const cols: PropertyInfo[] = [];
    const seen = new Set<string>();

    // Group field attributes with the field declaration via decoratedMembers so
    // a multiline `#[sea_orm(…)]` is attached to the field that follows it.
    const members = this.decoratedMembers(body, {
      style: "hash-square",
      lineComment: RustEntityExtractor.COMMENT,
    });

    const fieldRe = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^]+?)\s*,?\s*$/;

    for (const member of members) {
      try {
        const decl = member.declaration.trim();
        if (!decl) continue;
        // Skip struct/brace scaffolding lines.
        if (/\bstruct\b/.test(decl) || decl === "{" || decl === "}") continue;

        const decoratorText = member.decorators.join("\n");
        // Relation-defining attributes mean the following field is NOT a column.
        if (/\b(?:belongs_to|has_many|has_one|relation)\b/.test(decoratorText)) {
          continue;
        }

        // A single logical declaration may carry several comma-separated fields
        // (e.g. a one-line struct body). Split on top-level commas so each field
        // is parsed independently and generic commas inside `<…>` are preserved.
        for (const fragment of this.splitTopLevel(decl, ",")) {
          const frag = fragment.trim();
          if (!frag) continue;
          const m = fieldRe.exec(frag);
          if (!m) continue;
          const name = m[1];
          const rawType = m[2].trim();

          // `Related<…>` is a lazy relation accessor, never a stored column.
          if (/^Related\s*</.test(rawType)) continue;
          // `RelatedEntity` / association markers without generics are skipped.
          if (/^Related\b/.test(rawType)) continue;

          if (seen.has(name)) continue;
          seen.add(name);

          const cleaned = this.cleanType(rawType);
          cols.push(this.column(name, cleaned.type));
        }
      } catch {
        // Skip a field we couldn't parse rather than abort the whole struct.
      }
    }
    return cols;
  }

  /**
   * Parse the variants of a SeaORM `Relation` enum. Each variant is preceded by
   * a `#[sea_orm(belongs_to|has_many|has_one = "super::x::Entity", from = …,
   * to = …[, optional])]` attribute that may span multiple physical lines.
   */
  private parseSeaOrmRelations(body: string[]): SeaOrmRelation[] {
    const parsed: SeaOrmRelation[] = [];

    // Group each `#[sea_orm(...)]` attribute with the variant it precedes.
    const members = this.decoratedMembers(body, {
      style: "hash-square",
      lineComment: RustEntityExtractor.COMMENT,
    });

    for (const member of members) {
      try {
        const variantMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(member.declaration.trim());
        if (!variantMatch) continue;
        const variant = variantMatch[1];
        // Skip enum scaffolding.
        if (variant === "enum" || variant === "pub") continue;

        const args = member.decorators
          .filter((d) => /sea_orm/.test(d))
          .join(" ");
        if (!args) continue;

        let cardinality: EntityRelation["cardinality"] | null = null;
        let targetExpr: string | null = null;

        const belongs = /belongs_to\s*=\s*"([^"]+)"/.exec(args);
        const hasMany = /has_many\s*=\s*"([^"]+)"/.exec(args);
        const hasOne = /has_one\s*=\s*"([^"]+)"/.exec(args);
        // SeaORM also allows a generic `relation = "…"` form (treated has-many-ish).
        const relation = /\brelation\s*=\s*"([^"]+)"/.exec(args);

        if (belongs) {
          cardinality = "many-to-one";
          targetExpr = belongs[1];
        } else if (hasMany) {
          cardinality = "one-to-many";
          targetExpr = hasMany[1];
        } else if (hasOne) {
          cardinality = "one-to-one";
          targetExpr = hasOne[1];
        } else if (relation) {
          cardinality = "one-to-many";
          targetExpr = relation[1];
        }
        if (!cardinality || !targetExpr) continue;

        const toEntity = this.entityFromPath(targetExpr) ?? this.entityName(variant);

        // `from = "Column::AuthorId"` declares the owning FK column.
        let foreignKey: string | null = null;
        const fromMatch = /\bfrom\s*=\s*"([^"]+)"/.exec(args);
        if (fromMatch) foreignKey = this.columnPathToSnake(fromMatch[1]);

        // `optional` (bare keyword) ⇒ nullable FK.
        const optional = /\boptional\b/.test(args);

        parsed.push({ variant, cardinality, toEntity, foreignKey, optional });
      } catch {
        // Skip an unparseable variant.
      }
    }
    return parsed;
  }

  /**
   * Turn parsed SeaORM relation variants into EntityRelations, wiring inverse
   * field names between a has_many/has_one and a belongs_to that reference each
   * other within the same file (a common SeaORM pattern where both sides live
   * in one module).
   */
  private emitSeaOrmRelations(
    parsed: SeaOrmRelation[],
    fromEntity: string,
    out: EntityRelation[],
  ): void {
    for (const rel of parsed) {
      const fromField = this.lowerFirst(rel.variant);

      // Find an opposite-direction variant in the same enum pointing back, so we
      // can populate inverseField for the pair (e.g. has_many <-> belongs_to).
      let inverseField: string | null = null;
      const wantOpposite =
        rel.cardinality === "one-to-many"
          ? "many-to-one"
          : rel.cardinality === "many-to-one"
            ? "one-to-many"
            : rel.cardinality === "one-to-one"
              ? "one-to-one"
              : null;
      if (wantOpposite) {
        const mate = parsed.find(
          (o) =>
            o !== rel &&
            o.cardinality === wantOpposite &&
            o.toEntity === rel.toEntity,
        );
        if (mate) inverseField = this.lowerFirst(mate.variant);
      }

      out.push({
        fromEntity,
        fromField,
        toEntity: rel.toEntity,
        cardinality: rel.cardinality,
        foreignKey: rel.foreignKey,
        inverseField,
        optional: rel.optional || undefined,
        orm: "sea-orm",
        confidence: "EXTRACTED",
      });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Clean a Rust field type: strip references (`&`, `&mut`), unwrap `Option<…>`
   * (marking optional), then resolve the inner entity identifier via the shared
   * `coreType` helper so nested generics (`Vec<Box<i32>>`) are not truncated.
   * Returns the bare type for storage as a column type.
   */
  private cleanType(raw: string | null | undefined): { type: string | null; optional: boolean } {
    if (!raw) return { type: null, optional: false };
    let t = raw.trim();
    // Drop a trailing comma residue.
    t = t.replace(/,+$/, "").trim();
    // Strip leading + inner references.
    t = t.replace(/^&\s*(?:mut\s+)?/, "").trim();
    t = t.replace(/&\s*(?:mut\s+)?/g, "").trim();

    let optional = false;
    const optMatch = /^Option\s*<\s*([^]+)\s*>$/.exec(t);
    if (optMatch) {
      optional = true;
      t = optMatch[1].trim();
      t = t.replace(/^&\s*(?:mut\s+)?/, "").trim();
    }
    if (t.length === 0) return { type: null, optional };

    // For simple identifiers keep them verbatim; for wrappers / generics let
    // coreType resolve the inner type (won't truncate at internal commas).
    const isSimple = /^[A-Za-z_][A-Za-z0-9_]*$/.test(t);
    const resolved = isSimple ? t : this.coreType(t);
    return { type: resolved ?? t, optional };
  }

  /** Loose singularize + capitalize for a table identifier (users → User). */
  private entityName(table: string): string {
    let name = (table ?? "").trim();
    if (name.length === 0) return name;
    // Drop a single trailing 's' (loose singularize), preserving "…ss" words.
    if (name.length > 1 && /s$/i.test(name) && !/ss$/i.test(name)) {
      name = name.slice(0, -1);
    }
    return this.upperFirst(name);
  }

  /** Loose pluralize for a relation field name (User → users). */
  private plural(name: string): string {
    const lower = (name ?? "").trim();
    if (lower.length === 0) return lower;
    if (/s$/i.test(lower)) return lower;
    return `${lower}s`;
  }

  /**
   * Resolve a SeaORM relation target path → entity name.
   *   `super::users::Entity`        → User  (segment before `Entity`)
   *   `crate::models::User::Entity` → User
   *   `use_parent::RelatedEntity`   → RelatedEntity (no `Entity` segment)
   */
  private entityFromPath(path: string): string | null {
    const cleaned = (path ?? "").replace(/"/g, "").trim();
    const segments = cleaned.split("::").map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return null;
    const entityIdx = segments.findIndex((s) => s === "Entity" || s === "Model");
    const seg =
      entityIdx > 0 ? segments[entityIdx - 1] : segments[segments.length - 1];
    if (!seg) return null;
    // The segment before `Entity` may itself be a module (snake_case) → entity.
    return this.entityName(seg.includes("_") ? seg : this.upperFirst(seg));
  }

  /** `Column::UserId` / `super::x::Column::UserId` → `user_id`. */
  private columnPathToSnake(expr: string): string {
    const cleaned = (expr ?? "").replace(/"/g, "").trim();
    const last = cleaned.split("::").pop() ?? cleaned;
    return this.snake(last);
  }

  /** Final identifier segment of a (possibly module-qualified) path. */
  private lastSegment(path: string): string | null {
    const cleaned = (path ?? "").replace(/"/g, "").trim();
    const segs = cleaned.split("::").map((s) => s.trim()).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : null;
  }

  /**
   * Derive a relation field name from a foreign-key column. When the FK ends in
   * `_id` we drop the suffix (`author_id` → `author`); otherwise we use the FK
   * column verbatim so `foreignKey` and `fromField` stay consistent even for
   * non-standard names (`post`, `post_fk`).
   */
  private relationFieldFromFk(fk: string, parent: string): string {
    if (fk && /_id$/i.test(fk)) return fk.replace(/_id$/i, "");
    if (fk) return fk;
    return this.lowerFirst(parent);
  }

  /** CamelCase / PascalCase → snake_case. */
  private snake(s: string): string {
    return (s ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/[\s-]+/g, "_")
      .toLowerCase();
  }

  private upperFirst(s: string): string {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private lowerFirst(s: string): string {
    if (!s) return s;
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  /**
   * Split `s` on `sep` only at bracket depth 0 (string- and `<>`/`()`/`[]`/`{}`
   * aware), so a separator inside a generic argument (`Map<String, i32>`) does
   * not split the type apart.
   */
  private splitTopLevel(s: string, sep: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote = "";
    let buf = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (quote) {
        buf += ch;
        if (ch === "\\") { if (i + 1 < s.length) buf += s[++i]; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; buf += ch; continue; }
      if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
      if (ch === sep && depth <= 0) {
        out.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) out.push(buf);
    return out;
  }

  // ─── Brace tracking (comment / string aware) ──────────────────────────────

  /**
   * From a starting index (often the first decorator line of a member), find
   * the line index of the `struct …` / `enum …` declaration itself, so brace
   * scanning starts at the body and not inside an attribute. Falls back to the
   * starting index when no declaration keyword is found nearby.
   */
  private findStructLine(lines: string[], from: number): number {
    const re = /\b(?:struct|enum)\s+[A-Za-z_]/;
    for (let i = from; i < Math.min(lines.length, from + 12); i++) {
      if (re.test(lines[i] ?? "")) return i;
    }
    return from;
  }

  /**
   * Return the lines strictly *inside* a brace block, trimming the opening
   * `{ …` text on the first line and the `… }` on the last line so callers see
   * only member content. Single-line `{ … }` blocks collapse to that content.
   */
  private innerBody(block: BraceBlock): string[] {
    const body = block.body;
    if (body.length === 0) return [];
    const out: string[] = [];
    for (let i = 0; i < body.length; i++) {
      let line = body[i] ?? "";
      if (i === 0) {
        const brace = line.indexOf("{");
        if (brace >= 0) line = line.slice(brace + 1);
      }
      if (i === body.length - 1) {
        const brace = line.lastIndexOf("}");
        if (brace >= 0) line = line.slice(0, brace);
      }
      out.push(line);
    }
    return out;
  }

  /** Find the line index (>= from) of the first line containing `{`. */
  private findBraceOpen(lines: string[], from: number): number {
    for (let i = from; i < lines.length; i++) {
      const cleaned = this.stripLineComment(lines[i] ?? "", RustEntityExtractor.COMMENT);
      if (cleaned.includes("{")) return i;
    }
    return -1;
  }

  /**
   * Build a BraceBlock starting from the first `{` at or after `from`.
   * Convenience wrapper around `blockAt`.
   */
  private blockFrom(lines: string[], from: number): BraceBlock | null {
    const openLine = this.findBraceOpen(lines, from);
    if (openLine < 0) return null;
    return this.blockAt(lines, openLine);
  }

  /**
   * Given the index of a line containing the opening `{`, return the block up to
   * its matching `}`. Brace counting ignores braces inside `//` line comments,
   * C-style block comments, and string literals (via string-aware counting plus
   * comment masking) — fixing the naive-counting hazard.
   */
  private blockAt(lines: string[], openLine: number): BraceBlock | null {
    let depth = 0;
    let started = false;
    let inBlockComment = false;

    for (let i = openLine; i < lines.length; i++) {
      let line = lines[i] ?? "";

      // Handle (possibly multi-line) C-style block comments so their braces
      // don't perturb the depth counter.
      line = this.maskBlockComment(line, { inBlockComment });
      const wasInComment = inBlockComment;
      inBlockComment = this.endsInsideBlockComment(lines[i] ?? "", wasInComment);

      // Strip a trailing `//` line comment (string-aware) before counting.
      const cleaned = this.stripLineComment(line, RustEntityExtractor.COMMENT);

      // Count only `{` / `}` (bracketDelta also counts ()/[]; here we want
      // brace balance specifically, so use a brace-only string-aware counter).
      const delta = this.braceDelta(cleaned);
      if (delta !== 0) started = true;
      depth += delta;
      if (started && depth <= 0) {
        return { openLine, closeLine: i, body: lines.slice(openLine, i + 1) };
      }
    }
    // Unterminated — return best-effort block to end of file.
    return { openLine, closeLine: lines.length - 1, body: lines.slice(openLine) };
  }

  /** String-aware net change of `{` vs `}` on a line. */
  private braceDelta(line: string): number {
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
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    return depth;
  }

  /**
   * Blank out the contents of C-style block comments on a single line so any
   * braces inside them are ignored. `inBlockComment` indicates the line begins
   * already inside an unterminated block comment.
   */
  private maskBlockComment(line: string, opts: { inBlockComment: boolean }): string {
    let s = line;
    if (opts.inBlockComment) {
      const end = s.indexOf("*/");
      if (end < 0) return " ".repeat(s.length); // whole line still in comment
      s = " ".repeat(end + 2) + s.slice(end + 2);
    }
    // Remove any self-contained block comment on the line.
    return s.replace(/\/\*[^]*?\*\//g, (m) => " ".repeat(m.length));
  }

  /** Whether the line leaves us inside an unterminated C-style block comment. */
  private endsInsideBlockComment(line: string, startInside: boolean): boolean {
    let inside = startInside;
    for (let i = 0; i < line.length; i++) {
      if (inside) {
        if (line[i] === "*" && line[i + 1] === "/") { inside = false; i++; }
      } else {
        if (line[i] === "/" && line[i + 1] === "*") { inside = true; i++; }
      }
    }
    return inside;
  }
}
