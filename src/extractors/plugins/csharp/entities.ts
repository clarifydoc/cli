import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, DataSourceInfo, EntityRelation, FileAnalysis, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Entity-Framework-Core (and lightly, NHibernate) entity extractor for C#.
 *
 * Source-text based: PropertyInfo carries no attribute information, so we
 * re-scan each class body for data annotations and member shapes. All scanning
 * goes through the shared multiline-aware helpers on `EntityExtractor`
 * (`logicalLines` / `decoratedMembers` / `matchBracket`) so that inline,
 * stacked AND multiline `[Attribute]` declarations are handled uniformly —
 * the previous bespoke line-by-line scanner silently dropped all three.
 *
 * Detection has three phases:
 *   1) Discover entity class names — via `DbSet<T>` / `IDbSet<T>` declarations
 *      inside a `DbContext`, a `[Table]`/`[Class]` attribute, or inheritance
 *      from an already-discovered entity base class.
 *   2) For each entity class present in `ctx.analysis.classes`, walk its
 *      members splitting scalar columns from navigation relations, applying EF
 *      conventions (`<Nav>Id` shadow/explicit FK), `[ForeignKey]`, `[Column]`
 *      TypeName, `[Key]`, and NHibernate relation attributes.
 *   3) Best-effort parse of the EF Core Fluent API inside `OnModelCreating`
 *      (`modelBuilder.Entity<T>().HasOne(...).WithMany(...).HasForeignKey(...)`)
 *      to recover relations declared outside the entity classes.
 */
export class CSharpEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["csharp"];

  /** C# uses `//` line comments; pass to every helper that strips comments. */
  private static readonly LINE_COMMENT = ["//"] as const;

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    try {
      const entityNames = this.discoverEntityNames(ctx);

      // The Fluent API can describe relations even when no annotation/property
      // shape does, so always attempt it (it self-limits to non-scalar targets).
      // Two declaration sites: `modelBuilder.Entity<T>()` chains inside
      // OnModelCreating, and `builder.HasOne(...)` chains inside an
      // `IEntityTypeConfiguration<T>` class — the dominant pattern in larger EF
      // Core codebases, where every entity's mapping lives in its own config
      // class with NO `modelBuilder.Entity<T>()` head.
      const fluentRelations = [
        ...this.parseFluentApi(ctx),
        ...this.parseEntityConfigurations(ctx),
        ...this.parseModelSnapshot(ctx),
      ];

      if (entityNames.size === 0 && fluentRelations.length === 0) {
        return { entities, relations };
      }

      for (const cls of ctx.analysis.classes ?? []) {
        if (!entityNames.has(cls.name)) continue;

        let orm = "ef-core";
        let columns: PropertyInfo[] = [];
        let clsRelations: EntityRelation[] = [];
        let relationTargets: string[] = [];

        try {
          orm = this.detectOrm(ctx, cls);
          const parsed = this.parseClassBody(ctx, cls, entityNames, orm);
          columns = parsed.columns;
          clsRelations = parsed.relations;
          relationTargets = parsed.relationTargets;
        } catch {
          // A single unparseable class must not lose the others — skip it but
          // still emit a bare entity so the class is flagged as ORM-managed.
        }

        for (const rel of clsRelations) {
          relations.push({ ...rel, fromEntity: cls.name, orm });
        }

        entities.push(
          this.entity({
            name: cls.name,
            orm,
            properties: columns,
            implementsList: uniqueStrings(relationTargets),
            line: cls.line,
            endLine: cls.endLine,
          }),
        );
      }

      // Fluent relations are appended last; they take precedence semantically
      // (explicit configuration) and are de-duplicated against convention ones.
      for (const rel of fluentRelations) {
        if (!relations.some((r) => sameRelation(r, rel))) {
          relations.push(rel);
        } else {
          // Upgrade an existing INFERRED convention relation with the explicit
          // Fluent FK / cardinality when the Fluent side declares them.
          const existing = relations.find((r) => sameRelation(r, rel));
          if (existing) {
            if (rel.foreignKey && !existing.foreignKey) existing.foreignKey = rel.foreignKey;
            if (rel.confidence === "EXTRACTED") existing.confidence = "EXTRACTED";
            if (rel.inverseField && !existing.inverseField) existing.inverseField = rel.inverseField;
          }
        }
      }
    } catch {
      // Never throw from an extractor — return whatever we managed to collect.
    }

    return { entities, relations };
  }

  /**
   * Project-level pass: mark POCO entity classes that are declared as EF
   * entities ONLY in another file. A clean-architecture / database-first EF Core
   * codebase commonly defines a plain domain class (`class Institution : IEventModel`
   * — no `[Table]`, no entity base) whose entity-ness is established elsewhere via
   * `DbSet<Institution>` in the DbContext and/or an `IEntityTypeConfiguration<Institution>`
   * class. Per-file discovery cannot see those cross-file declarations, so the
   * POCO never gets the `entity` decorator and so is absent from the ER graph —
   * which also drops every relation that points at it. This pass collects the EF
   * entity type names from `DbSet<T>` properties and `IEntityTypeConfiguration<T>`
   * bases across ALL files, then tags the matching domain classes so they become
   * ER nodes (and their config-declared relations resolve). Mutates in place.
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    // (1) Names declared as EF entities by `DbSet<T>` or `IEntityTypeConfiguration<T>`.
    const efEntityNames = new Set<string>();
    for (const a of analyses) {
      for (const cls of a.classes ?? []) {
        // `DbSet<T>` / `IDbSet<T>` properties — the authoritative entity set.
        for (const p of cls.properties ?? []) {
          for (const m of (p.type ?? "").matchAll(DBSET_RE)) {
            const t = bareType(m[1]);
            if (t) efEntityNames.add(t);
          }
        }
        // `IEntityTypeConfiguration<T>` — lands in extends or implements
        // depending on how the class extractor split the base list.
        for (const decl of [cls.extends ?? "", ...(cls.implements ?? [])]) {
          const m = /IEntityTypeConfiguration\s*<\s*([^>]+?)\s*>/.exec(decl);
          if (m) {
            const t = bareType(m[1]);
            if (t) efEntityNames.add(t);
          }
        }
      }
    }
    // Marr / NzbDrone-style table mapping (the *arr family): the mapper call
    // names the model class and its table — `Mapper.Entity<Movie>("Movies")`.
    const marrEntityNames = new Set<string>();
    for (const a of analyses) {
      if (a.language !== "csharp") continue;
      for (const call of allCalls(a)) {
        for (const m of call.name.matchAll(/\bEntity<\s*([\w.]+)\s*>\s*\(\s*"\w+"/g)) {
          const t = bareType(m[1]);
          if (t) marrEntityNames.add(t);
        }
      }
    }

    attributeRepositoryAccesses(analyses);
    if (efEntityNames.size === 0 && marrEntityNames.size === 0) return;

    // (2) Tag the matching domain POCO classes so they become ER nodes.
    for (const a of analyses) {
      // A class in a clearly non-persistence folder (DTO / view model /
      // API contract) that merely shares an entity's name is NOT the entity —
      // tagging it would add a phantom ER node and mis-route relations.
      if (NON_ENTITY_PATH_RE.test(a.filePath)) continue;
      for (const cls of a.classes ?? []) {
        const orm = efEntityNames.has(cls.name) ? "ef-core" : marrEntityNames.has(cls.name) ? "marr" : null;
        if (!orm) continue;
        const decs = cls.decorators ?? (cls.decorators = []);
        if (decs.includes("entity")) continue;
        decs.push("entity", orm);
      }
    }

    // (3) The set of all entity names (after tagging above).
    const entityNames = new Set<string>();
    for (const a of analyses) {
      for (const cls of a.classes ?? []) {
        if ((cls.decorators ?? []).includes("entity")) entityNames.add(cls.name);
      }
    }

    // (3b) Per-entity navigation map (nav property name -> the entity its
    // declared TYPE points at), built BEFORE the column pruning below so the
    // declared nav types are still present.
    const navTargetOf = (type: string | null): string | null => {
      const inner = collectionInner(type ?? "");
      const bare = inner ? bareType(inner) : bareType(type ?? "");
      return bare && entityNames.has(bare) && !isScalar(bare) && !isDenylistedType(bare) ? bare : null;
    };
    const navIndex = new Map<string, Map<string, string>>();
    for (const a of analyses) {
      for (const cls of a.classes ?? []) {
        if (!(cls.decorators ?? []).includes("entity")) continue;
        for (const p of cls.properties ?? []) {
          const target = navTargetOf(p.type);
          if (!target) continue;
          let m = navIndex.get(cls.name);
          if (!m) navIndex.set(cls.name, (m = new Map()));
          if (!m.has(p.name)) m.set(p.name, target);
        }
      }
    }

    // (4) Correct relation targets the per-file config pass guessed from a
    // navigation lambda's PROPERTY NAME: `builder.HasOne(a => a.Ansat)` with no
    // explicit `<T>` yields toEntity "Ansat", but the `Ansat` property is of type
    // `TrioSyncAnsat`. The config pass sees only the lambda, never the entity
    // class, so a nav whose name differs from its type never resolved. The index
    // only holds known-entity targets, so this can only repoint at a real node.
    for (const a of analyses) {
      for (const r of a.entityRelations ?? []) {
        const declared = navIndex.get(r.fromEntity)?.get(r.fromField);
        if (declared && declared !== r.toEntity) r.toEntity = declared;
      }
    }

    // (5) Derive navigation relations from entity-typed properties (POCOs only
    // still carry them — per-file entities had theirs pruned).
    for (const a of analyses) {
      for (const cls of a.classes ?? []) {
        if (!(cls.decorators ?? []).includes("entity")) continue;
        const props = cls.properties ?? [];
        if (props.length === 0) continue;
        // Case-insensitive column lookup so a synthesized convention FK
        // (`<Nav>Id` / `<Type>Id`) reports the column's REAL casing
        // (`INSTITUTIONID`, not `InstitutionId`) — and reports none when no such
        // column exists, rather than a fabricated label.
        const colByLower = new Map(props.map((p) => [p.name.toLowerCase(), p.name]));
        const seen = new Set(
          (a.entityRelations ?? [])
            .filter((r) => r.fromEntity === cls.name)
            .map((r) => `${r.fromField} ${r.toEntity}`),
        );
        const derived: EntityRelation[] = [];
        const keep: PropertyInfo[] = [];
        for (const p of props) {
          const rawType = p.type ?? "";
          const inner = collectionInner(rawType);
          if (inner) {
            const target = bareType(inner);
            if (target && entityNames.has(target) && !isScalar(target) && !isDenylistedType(target)) {
              if (!seen.has(`${p.name} ${target}`)) {
                derived.push({
                  fromEntity: cls.name, fromField: p.name, toEntity: target,
                  cardinality: "one-to-many", foreignKey: null, optional: false,
                  confidence: "INFERRED", orm: "ef-core",
                });
              }
              continue; // navigation collection — not a scalar column
            }
            keep.push(p);
            continue;
          }
          const bare = bareType(rawType);
          if (bare && entityNames.has(bare) && !isScalar(bare) && !isDenylistedType(bare)) {
            const fk =
              colByLower.get(`${p.name}Id`.toLowerCase()) ??
              colByLower.get(`${bare}Id`.toLowerCase()) ??
              null;
            if (!seen.has(`${p.name} ${bare}`)) {
              derived.push({
                fromEntity: cls.name, fromField: p.name, toEntity: bare,
                cardinality: "many-to-one", foreignKey: fk, optional: isNullable(rawType),
                confidence: "INFERRED", orm: "ef-core",
              });
            }
            continue; // reference navigation — the scalar FK column is kept above
          }
          keep.push(p);
        }
        if (derived.length > 0) {
          a.entityRelations = [...(a.entityRelations ?? []), ...derived];
          cls.properties = keep;
        }
      }
    }
  }

  // ── Phase 1: which class names are entities? ───────────────────────────

  private discoverEntityNames(ctx: EntityExtractContext): Set<string> {
    const names = new Set<string>();
    const lines = ctx.lines ?? [];

    // (a) DbSet<T> / IDbSet<T> properties declared inside DbContext classes.
    for (const cls of ctx.analysis.classes ?? []) {
      if (!this.isDbContext(ctx, cls)) continue;
      for (const line of this.bodyOf(ctx, cls)) {
        for (const t of this.dbSetTargets(line)) names.add(t);
      }
    }

    // Fallback: scan the whole file for DbSet<T>/IDbSet<T> even when the owning
    // class wasn't recognised as a DbContext (partial classes, missing endLine).
    for (const line of lines) {
      for (const t of this.dbSetTargets(line)) names.add(t);
    }

    // (b) Classes carrying a [Table(...)] / [Class] (NHibernate) attribute.
    for (const cls of ctx.analysis.classes ?? []) {
      if (this.hasMappingAttribute(ctx, cls)) names.add(cls.name);
    }

    // (c) Inheritance-based discovery (TPH/TPT): a class extending an entity we
    // already know about is itself an entity. Iterate to a fixpoint so chains
    // (A -> B -> C) all resolve regardless of declaration order.
    let changed = true;
    while (changed) {
      changed = false;
      for (const cls of ctx.analysis.classes ?? []) {
        if (names.has(cls.name)) continue;
        const base = bareType(cls.extends);
        if (base && names.has(base)) {
          names.add(cls.name);
          changed = true;
        }
      }
    }

    return names;
  }

  /** All DbSet<T>/IDbSet<T> target type names on a single line. */
  private dbSetTargets(line: string): string[] {
    const out: string[] = [];
    for (const m of line.matchAll(DBSET_RE)) {
      const t = bareType(m[1]);
      if (t) out.push(t);
    }
    return out;
  }

  private isDbContext(ctx: EntityExtractContext, cls: ClassInfo): boolean {
    if (cls.extends && /(^|\.)DbContext$/.test(cls.extends.trim())) return true;
    // Defensive: a base list the class extractor folded into `implements`.
    if ((cls.implements ?? []).some((i) => /(^|\.)DbContext$/.test(i.trim()))) {
      return true;
    }
    // Source-line fallback: `class X : DbContext` / `: ... DbContext`.
    const header = this.headerLine(ctx, cls);
    return header != null && /\bclass\b[^{]*:\s*[^{]*\bDbContext\b/.test(header);
  }

  /** `[Table(...)]` (EF Core) or `[Class]` (NHibernate) on or above the class. */
  private hasMappingAttribute(ctx: EntityExtractContext, cls: ClassInfo): boolean {
    if ((cls.decorators ?? []).some((d) => /(^|[^a-z])(Table|Class)\b/i.test(d))) return true;
    for (const attr of this.classAttributes(ctx, cls)) {
      if (/^\[\s*(Table|Class)\b/i.test(attr)) return true;
    }
    return false;
  }

  private detectOrm(ctx: EntityExtractContext, cls: ClassInfo): string {
    // NHibernate maps via a [Class] attribute (or fluent/xml elsewhere). We
    // only flip to "nhibernate" when that attribute is clearly on the class.
    // Case-insensitive so `[CLASS]`/`[class]` are also recognised.
    if ((cls.decorators ?? []).some((d) => /(^|[^a-z])Class\b/i.test(d))) {
      return "nhibernate";
    }
    for (const attr of this.classAttributes(ctx, cls)) {
      if (/^\[\s*Class\b/i.test(attr)) return "nhibernate";
    }
    return "ef-core";
  }

  /**
   * Collect the attribute strings sitting on the class declaration and the
   * lines immediately above it. Uses `logicalLines` so a multiline `[Table(`
   * ... `)]` attribute is returned as one entry rather than fragments.
   */
  private classAttributes(ctx: EntityExtractContext, cls: ClassInfo): string[] {
    const lines = ctx.lines ?? [];
    const idx = cls.line - 1;
    if (idx < 0) return [];
    // Walk upwards from the class header collecting ONLY the contiguous block of
    // attributes directly above it. Stop at the first line that is neither blank
    // nor an attribute — otherwise a `[Table]`/`[Class]` on a PRECEDING
    // declaration leaks onto this class (false-positive entity + wrong ORM).
    const start = Math.max(0, idx - 12);
    const slice = lines.slice(start, idx + 1);
    const logical = this.logicalLines(slice, { lineComment: CSharpEntityExtractor.LINE_COMMENT });
    // Drop the class-header logical line itself (last entry), then walk back.
    const headerText = logical.length > 0 ? logical[logical.length - 1]!.text.trim() : "";
    const aboveHeader = headerText.startsWith("[") ? logical : logical.slice(0, -1);
    const attrs: string[] = [];
    for (let i = aboveHeader.length - 1; i >= 0; i--) {
      const text = aboveHeader[i]!.text.trim();
      if (text === "") continue;
      if (text.startsWith("[")) {
        // A logical line may carry several stacked attributes; split them.
        for (const a of this.splitAttributes(text)) attrs.push(a);
        continue;
      }
      // First non-blank, non-attribute line above the class ends the block.
      break;
    }
    return attrs;
  }

  /** Split a leading run of `[A][B]`-style attributes into individual strings. */
  private splitAttributes(text: string): string[] {
    const attrs: string[] = [];
    let s = text.trim();
    while (s.startsWith("[")) {
      const end = this.matchBracket(s, 0);
      if (end < 0) break;
      attrs.push(s.slice(0, end + 1));
      s = s.slice(end + 1).trim();
    }
    return attrs;
  }

  // ── Phase 2: parse one entity's members ────────────────────────────────

  private parseClassBody(
    ctx: EntityExtractContext,
    cls: ClassInfo,
    entityNames: Set<string>,
    orm: string,
  ): {
    columns: PropertyInfo[];
    relations: EntityRelation[];
    relationTargets: string[];
  } {
    const body = this.bodyOf(ctx, cls);
    const members = this.collectMembers(body);

    const columns: PropertyInfo[] = [];
    const relations: EntityRelation[] = [];
    const relationTargets: string[] = [];

    // Record-with-primary-constructor support: `public record User(int Id, ...)`
    // declares its columns in the header, not as auto-properties.
    for (const param of this.recordParameters(ctx, cls)) {
      members.push(param);
    }

    // Pre-index property names for FK-convention sibling lookup.
    const propNames = new Set(members.map((m) => m.name));

    for (const member of members) {
      try {
        const rawType = member.type;
        const inner = collectionInner(rawType);

        // NHibernate declares cardinality explicitly via relation attributes.
        const nh = orm === "nhibernate" ? nhibernateRelation(member.attributes) : null;

        if (inner) {
          // Navigation collection. EF infers one-to-many without a join entity;
          // NHibernate [Set]/[Bag] are also one-to-many (EXTRACTED).
          const target = bareType(inner);
          if (target && !isScalar(target) && !isNonEntityGeneric(rawType)) {
            relations.push({
              fromEntity: cls.name,
              fromField: member.name,
              toEntity: target,
              cardinality: "one-to-many",
              foreignKey: null,
              optional: false,
              confidence: nh ? "EXTRACTED" : "INFERRED",
            });
            relationTargets.push(target);
          } else if (target && !isScalar(target)) {
            // Generic value container (Dictionary/Tuple/…) → plain column.
            columns.push(this.makeColumn(member));
          }
          continue;
        }

        const bare = bareType(rawType);
        if (!bare) continue;

        // [NotMapped] members are not persisted at all — skip entirely.
        if (member.attributes.some((a) => /^\[\s*NotMapped\b/i.test(a))) {
          continue;
        }

        if (isScalar(bare) || isScalarRaw(rawType)) {
          columns.push(this.makeColumn(member));
          continue;
        }

        // Non-collection generic value type (Dictionary/Tuple/KeyValuePair) or a
        // well-known JSON/value payload → store as a column, never a relation.
        if (isNonEntityGeneric(rawType) || isDenylistedType(bare)) {
          columns.push(this.makeColumn(member));
          continue;
        }

        // [Owned] value object — same-table value type, NOT a relation. Without
        // cross-file context we honour an explicit [Owned] on the member.
        if (member.attributes.some((a) => /^\[\s*Owned\b/i.test(a))) {
          columns.push(this.makeColumn(member));
          continue;
        }

        // A capitalized, non-scalar type that is (or could be) another entity →
        // many-to-one (or, for NHibernate [ManyToOne], EXTRACTED) navigation.
        if (isLikelyEntityType(bare)) {
          const fk = resolveForeignKey(member, bare, propNames);
          const optional = isNullable(rawType);
          const fromAttr = fk.fromAttribute || nh === "many-to-one";
          relations.push({
            fromEntity: cls.name,
            fromField: member.name,
            toEntity: bare,
            cardinality: nh === "one-to-many" ? "one-to-many" : "many-to-one",
            foreignKey: fk.column,
            optional,
            // Composite FKs ("A,B") are ambiguous against a single property.
            confidence: fk.composite ? "AMBIGUOUS" : fromAttr ? "EXTRACTED" : "INFERRED",
          });
          relationTargets.push(bare);
          // The FK property itself (if explicit) is still a real scalar column.
        } else {
          // Unknown PascalCase non-collection type we can't classify — treat as
          // a column so we don't silently drop it.
          columns.push(this.makeColumn(member));
        }
      } catch {
        // Skip any member we can't parse; keep going.
      }
    }

    return { columns, relations, relationTargets };
  }

  /**
   * Build a column PropertyInfo, honouring `[Column(TypeName="...")]` so the
   * recorded type reflects the database type when the annotation declares it.
   */
  private makeColumn(member: Member): PropertyInfo {
    const typeName = columnTypeName(member.attributes);
    return this.column(member.name, typeName ?? member.type);
  }

  /**
   * Collect persisted members from a class body. Delegates the heavy lifting to
   * `decoratedMembers` (style: "square") which groups stacked / inline /
   * multiline `[Attribute]` runs with the declaration they precede — fixing the
   * three multiline/inline bugs in the previous hand-rolled scanner.
   *
   * Only settable auto-properties (`{ get; set; }` / `{ get; init; }`) become
   * members; get-only and expression-bodied properties are deliberately skipped
   * (they are typically computed and not mapped columns).
   */
  private collectMembers(body: string[]): Member[] {
    const members: Member[] = [];
    // `bodyOf` includes the class header (`class Post {`) and trailing `}`. If we
    // hand that straight to the multiline helpers the unclosed class-level `{`
    // makes the whole body collapse into one logical statement, so first reduce
    // it to just the lines *inside* the class braces.
    const inner = this.innerBodyLines(body);
    const decorated = this.decoratedMembers(inner, {
      style: "square",
      lineComment: CSharpEntityExtractor.LINE_COMMENT,
    });

    for (const dm of decorated) {
      try {
        const decl = dm.declaration.trim();
        if (!decl) continue;
        const m = AUTO_PROP_RE.exec(decl);
        if (!m) continue; // not a settable auto-property — skip.
        members.push({
          name: m[2],
          type: m[1].trim(),
          attributes: dm.decorators,
        });
      } catch {
        // Skip any member we can't parse; keep going.
      }
    }

    return members;
  }

  /**
   * Reduce a `bodyOf(...)` slice (which includes the class header and outer
   * braces) to just the lines between the class's opening `{` and its matching
   * `}`. String-aware brace matching over the joined text; returns the original
   * physical lines that fall inside the body so per-member line offsets and
   * multiline detection still work.
   */
  private innerBodyLines(body: string[]): string[] {
    const joined = body.join("\n");
    const open = this.indexOfTopBrace(joined);
    if (open < 0) return body; // no class brace found (e.g. one-liner record) — use as-is.
    const close = this.matchBracket(joined, open);
    const endPos = close < 0 ? joined.length : close;
    // Slice the text strictly between the class braces, dropping the header and
    // the closing brace, then split back into lines for the multiline helpers.
    return joined.slice(open + 1, endPos).split("\n");
  }

  /** Index of the first `{` that opens the class body, ignoring strings. */
  private indexOfTopBrace(s: string): number {
    let quote = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") return i;
    }
    return -1;
  }

  /**
   * For `public record User(int Id, string Name)` style declarations, parse the
   * primary-constructor parameters as columns. Best-effort: reads the class
   * header line(s) via `logicalLines` so a multiline parameter list collapses
   * into one statement, then splits the top-level parameter list.
   */
  private recordParameters(ctx: EntityExtractContext, cls: ClassInfo): Member[] {
    const lines = ctx.lines ?? [];
    const idx = cls.line - 1;
    if (idx < 0 || idx >= lines.length) return [];
    // Collapse the header (which may wrap) into a single logical statement.
    const slice = lines.slice(idx, Math.min(lines.length, idx + 12));
    const logical = this.logicalLines(slice, { lineComment: CSharpEntityExtractor.LINE_COMMENT });
    const header = logical.length > 0 ? logical[0].text : "";
    const rm = RECORD_HEADER_RE.exec(header);
    if (!rm) return [];
    const open = header.indexOf("(", rm.index);
    if (open < 0) return [];
    const close = this.matchBracket(header, open);
    if (close < 0) return [];
    const paramList = header.slice(open + 1, close).trim();
    if (!paramList) return [];

    const out: Member[] = [];
    for (const part of splitTopLevel(paramList, ",")) {
      const p = part.trim();
      if (!p) continue;
      // `Type Name` or `Type Name = default` — strip any default value.
      const pm = /^([A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])?\??)\s+([A-Za-z_]\w*)\s*(?:=.*)?$/.exec(p);
      if (pm) out.push({ name: pm[2], type: pm[1].trim(), attributes: [] });
    }
    return out;
  }

  // ── Phase 3: EF Core Fluent API in OnModelCreating ─────────────────────

  /**
   * Best-effort extraction of relations declared via the EF Core Fluent API.
   * A fluent chain such as `modelBuilder.Entity<T>().HasOne(...).WithMany(...);`
   * is usually written across several lines, but each line is independently
   * bracket-balanced, so `logicalLines` would NOT join them. Instead we merge
   * lines into statements terminated by a top-level `;`, then scan each whole
   * statement for `modelBuilder.Entity<From>()` chains carrying
   * `HasOne`/`HasMany`/`WithMany`/`WithOne`/`HasForeignKey`/`UsingEntity`. The
   * resulting cardinality is derived from the Has.../With... pair.
   */
  private parseFluentApi(ctx: EntityExtractContext): EntityRelation[] {
    const out: EntityRelation[] = [];
    const lines = ctx.lines ?? [];
    if (lines.length === 0) return out;

    let statements: string[];
    try {
      statements = this.joinFluentStatements(lines);
    } catch {
      return out;
    }

    for (const text of statements) {
      try {
        const entMatch = ENTITY_CALL_RE.exec(text);
        if (!entMatch) continue;
        const from = bareType(entMatch[1]);
        if (!from) continue;
        const rel = this.relationFromStatement(text, from);
        if (rel) out.push(rel);
      } catch {
        // Skip any chain we can't parse; keep going.
      }
    }

    return out;
  }

  /**
   * Extract relations declared inside `IEntityTypeConfiguration<T>` classes.
   * Unlike `modelBuilder.Entity<T>()` chains, a configuration class writes
   * `builder.HasOne(...)` with NO entity head — the source entity for EVERY
   * chain in the class is the configuration's generic argument T, recovered
   * from the `IEntityTypeConfiguration<T>` base or the `EntityTypeBuilder<T>`
   * `Configure` parameter. This is the dominant relationship-declaration site
   * in larger EF Core codebases (e.g. one config class per entity), invisible
   * to `parseFluentApi` because it never mentions `.Entity<`.
   */
  private parseEntityConfigurations(ctx: EntityExtractContext): EntityRelation[] {
    const out: EntityRelation[] = [];
    // Cheap file-level guard: only EF configuration classes carry these tokens,
    // so non-config files (the overwhelming majority) skip the per-class scan.
    if (!CONFIG_MARKER_RE.test(ctx.sourceText)) return out;

    for (const cls of ctx.analysis.classes ?? []) {
      try {
        const from = this.configEntityOf(ctx, cls);
        if (!from) continue;
        const body = this.bodyOf(ctx, cls);
        const statements = this.collectStatements(body, (s) => REL_VERB_RE.test(s));
        for (const text of statements) {
          const rel = this.relationFromStatement(text, from);
          if (rel) out.push(rel);
        }
      } catch {
        // A single unparseable configuration class must not lose the others.
      }
    }

    return out;
  }

  /**
   * The entity type a configuration class maps: the generic argument of
   * `IEntityTypeConfiguration<T>` (preferred) or, failing that, the
   * `EntityTypeBuilder<T>` `Configure` parameter. Returns null when the class
   * is not an EF entity configuration.
   */
  private configEntityOf(ctx: EntityExtractContext, cls: ClassInfo): string | null {
    const text = this.bodyOf(ctx, cls).join("\n");
    const iface = /IEntityTypeConfiguration\s*<\s*([A-Za-z_][\w.]*)\s*>/.exec(text);
    if (iface) return bareType(iface[1]);
    const param = /EntityTypeBuilder\s*<\s*([A-Za-z_][\w.]*)\s*>/.exec(text);
    if (param) return bareType(param[1]);
    return null;
  }

  /**
   * Extract relations from an EF Core **ModelSnapshot** (`*ModelSnapshot.cs`) —
   * the generated but committed, authoritative model the EF tooling keeps in
   * sync. Its relationship section uses the string-arg form
   * `modelBuilder.Entity("Ns.From", b => { b.HasOne("Ns.To","nav").WithMany().HasForeignKey("Col") })`,
   * which the `<T>`-only `parseFluentApi` and the config-class pass both miss.
   * This recovers relationships declared purely by EF convention (no nav
   * property, no explicit `IEntityTypeConfiguration`), with EXACT FK columns.
   *
   * Scoped to the current `*ModelSnapshot.cs` ONLY — never the per-migration
   * `*.Designer.cs` files, which each embed a full historical snapshot and would
   * multiply every relation by the migration count. No nodes are created here
   * (the snapshot's fully-qualified names can disagree with authored class names
   * across model layers); relations whose endpoints don't resolve to an already
   * discovered entity are simply dropped by the graph builder.
   */
  private parseModelSnapshot(ctx: EntityExtractContext): EntityRelation[] {
    const out: EntityRelation[] = [];
    const filePath = ctx.analysis.filePath ?? "";
    if (!/ModelSnapshot\.cs$/i.test(filePath)) return out;

    // Line-oriented scan: an EF snapshot wraps relationships in
    // `modelBuilder.Entity("From", b => { b.HasOne("To","nav").WithMany().HasForeignKey("Col"); ... })`
    // blocks. The `Entity(` paren stays open across the whole lambda body, so a
    // statement-joiner would fuse the entire block; instead we track the current
    // `from` entity from each `Entity("...")` line and accumulate each
    // `b.HasOne(...)` chain until the next chain / block / end.
    let from = "";
    let pendingTo = "";
    let pendingNav = "";
    let chain = "";

    const flush = (): void => {
      if (from && pendingTo && !isScalar(pendingTo) && !isDenylistedType(pendingTo)) {
        // WithOne → one-to-one; otherwise the dependent side is many.
        const cardinality: EntityRelation["cardinality"] = /\.\s*WithOne\s*\(/.test(chain)
          ? "one-to-one"
          : "many-to-one";
        // many-to-one: `HasForeignKey("Col")`; one-to-one: `HasForeignKey("DepType","Col")`.
        const fk = /\.\s*HasForeignKey\s*\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?/.exec(chain);
        out.push({
          fromEntity: from,
          fromField: pendingNav || lowerFirst(pendingTo),
          toEntity: pendingTo,
          cardinality,
          foreignKey: fk ? fk[2] ?? fk[1] : null,
          confidence: "EXTRACTED",
          orm: "ef-core",
        });
      }
      pendingTo = "";
      pendingNav = "";
      chain = "";
    };

    for (const raw of ctx.lines ?? []) {
      try {
        const line = this.stripLineComment(raw, CSharpEntityExtractor.LINE_COMMENT);
        const ent = /\.\s*Entity\s*\(\s*"([^"]+)"/.exec(line);
        if (ent) { flush(); from = bareType(ent[1]); continue; }
        const ho = /\.\s*HasOne\s*\(\s*"([^"]+)"\s*(?:,\s*"([^"]+)")?/.exec(line);
        if (ho) { flush(); pendingTo = bareType(ho[1]); pendingNav = ho[2] ?? ""; chain = line; continue; }
        if (pendingTo) chain += " " + line;
      } catch {
        // Skip any line we can't parse; keep going.
      }
    }
    flush();
    return out;
  }

  /**
   * Parse a single fluent configuration statement into an EntityRelation, given
   * the already-resolved source entity `from`. Recognises the full
   * `HasOne/HasMany` × `WithOne/WithMany` cardinality matrix plus
   * `HasForeignKey` / `UsingEntity`. Returns null for non-relation chains
   * (`Property`/`HasKey`/`ToTable`/`OwnsOne`/…) and unresolvable targets.
   */
  private relationFromStatement(text: string, from: string): EntityRelation | null {
    // Skip pure value-type / owned configuration chains.
    if (/\.\s*OwnsOne\b|\.\s*OwnsMany\b|\.\s*Ignore\b/.test(text)) return null;

    // Determine the target entity from HasOne<T> / HasMany<T> or the lambda
    // navigation property (`p => p.Author`).
    const hasOne = /\.\s*HasOne\s*(?:<\s*([^>]+?)\s*>)?\s*\(([^)]*)\)/.exec(text);
    const hasMany = /\.\s*HasMany\s*(?:<\s*([^>]+?)\s*>)?\s*\(([^)]*)\)/.exec(text);
    const withMany = /\.\s*WithMany\s*(?:<\s*[^>]+?\s*>)?\s*\(([^)]*)\)/.exec(text);
    const withOne = /\.\s*WithOne\s*(?:<\s*[^>]+?\s*>)?\s*\(([^)]*)\)/.exec(text);
    const fkMatch = /\.\s*HasForeignKey\s*(?:<\s*[^>]+?\s*>)?\s*\(([^)]*)\)/.exec(text);
    const joinMatch = /\.\s*UsingEntity\s*<\s*([^>]+?)\s*>/.exec(text);

    const navTarget = (m: RegExpExecArray | null): string => {
      if (!m) return "";
      if (m[1]) return bareType(m[1]); // explicit generic <T>
      return navTypeFromLambda(m[2] ?? "");
    };

    let toEntity = "";
    let cardinality: EntityRelation["cardinality"] | null = null;
    let fromFieldName = "";
    let inverseField: string | null = null;

    if (hasOne && withMany) {
      // many-to-one (HasOne ... WithMany)
      toEntity = navTarget(hasOne);
      cardinality = "many-to-one";
      fromFieldName = lambdaProperty(hasOne[2] ?? "");
      inverseField = lambdaProperty(withMany[1] ?? "") || null;
    } else if (hasMany && withOne) {
      // one-to-many (HasMany ... WithOne)
      toEntity = navTarget(hasMany);
      cardinality = "one-to-many";
      fromFieldName = lambdaProperty(hasMany[2] ?? "");
      inverseField = lambdaProperty(withOne[1] ?? "") || null;
    } else if (hasMany && withMany) {
      // many-to-many (HasMany ... WithMany)
      toEntity = navTarget(hasMany);
      cardinality = "many-to-many";
      fromFieldName = lambdaProperty(hasMany[2] ?? "");
      inverseField = lambdaProperty(withMany[1] ?? "") || null;
    } else if (hasOne && withOne) {
      // one-to-one (HasOne ... WithOne)
      toEntity = navTarget(hasOne);
      cardinality = "one-to-one";
      fromFieldName = lambdaProperty(hasOne[2] ?? "");
      inverseField = lambdaProperty(withOne[1] ?? "") || null;
    } else if (hasOne) {
      toEntity = navTarget(hasOne);
      cardinality = "many-to-one";
      fromFieldName = lambdaProperty(hasOne[2] ?? "");
    } else if (hasMany) {
      toEntity = navTarget(hasMany);
      cardinality = "one-to-many";
      fromFieldName = lambdaProperty(hasMany[2] ?? "");
    }

    if (!toEntity || !cardinality) return null;
    if (isScalar(toEntity) || isDenylistedType(toEntity)) return null;

    const foreignKey = fkMatch ? lambdaProperty(fkMatch[1] ?? "") || null : null;
    const joinTable = joinMatch ? bareType(joinMatch[1]) || null : null;

    return {
      fromEntity: from,
      fromField: fromFieldName || lowerFirst(toEntity),
      toEntity,
      cardinality,
      foreignKey,
      inverseField,
      joinTable: cardinality === "many-to-many" ? joinTable : undefined,
      // FK / explicit cardinality declared by the Fluent chain → EXTRACTED.
      confidence: "EXTRACTED",
      orm: "ef-core",
    };
  }

  /**
   * Merge physical lines into `;`-terminated statements (string- and
   * bracket-aware) so a fluent method chain split across lines is recombined.
   * Only statements that mention `.Entity<` are returned, keeping the scan
   * focused on EF configuration and cheap.
   */
  private joinFluentStatements(lines: string[]): string[] {
    return this.collectStatements(lines, (s) => /\.\s*Entity\s*</.test(s));
  }

  /**
   * Merge physical lines into `;`-terminated statements (string- and
   * paren/bracket-aware) so a fluent method chain split across lines is
   * recombined, then keep only statements for which `keep` returns true. `{}`
   * (class / method bodies) act as boundaries but never hold a statement open,
   * so a `;` ending a chain inside a method body is still seen as a terminator.
   */
  private collectStatements(lines: string[], keep: (statement: string) => boolean): string[] {
    const out: string[] = [];
    let buf = "";
    // Only `()` / `[]` nesting holds a statement open; `{}` (class/method bodies)
    // must NOT, or the `;` ending a fluent chain inside a method would never be
    // seen as a statement terminator.
    let depth = 0;
    let quote = "";
    const flush = () => {
      if (keep(buf)) out.push(buf);
      buf = "";
    };
    for (const raw of lines) {
      const line = this.stripLineComment(raw, CSharpEntityExtractor.LINE_COMMENT);
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (quote) {
          buf += ch;
          if (ch === "\\") { buf += line[++i] ?? ""; continue; }
          if (ch === quote) quote = "";
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; buf += ch; continue; }
        if (ch === "(" || ch === "[") { depth++; buf += ch; continue; }
        if (ch === ")" || ch === "]") { if (depth > 0) depth--; buf += ch; continue; }
        if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) {
          // Statement / block boundary at paren-depth 0 ends the current chain.
          flush();
          continue;
        }
        buf += ch;
      }
      buf += " "; // line break → token separator inside an open statement.
    }
    flush();
    return out;
  }

  // ── small source-line helpers ──────────────────────────────────────────

  private headerLine(ctx: EntityExtractContext, cls: ClassInfo): string | null {
    const idx = cls.line - 1;
    const lines = ctx.lines ?? [];
    if (idx < 0 || idx >= lines.length) return null;
    return lines[idx];
  }
}

interface Member {
  name: string;
  type: string;
  attributes: string[];
}

// ── regexes ────────────────────────────────────────────────────────────

// `public DbSet<Entity> Foo { get; set; }` / `IDbSet<Entity>` / bare generics.
const DBSET_RE = /\bI?DbSet\s*<\s*([^>]+?)\s*>/g;
// Settable auto-property: `public Type Name { get; set; }` / `{ get; init; }`.
// Requires an explicit `set`/`init` so get-only computed properties are skipped.
const AUTO_PROP_RE =
  /^public\s+(?:virtual\s+|override\s+|new\s+|required\s+|sealed\s+|abstract\s+)*([A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])?\??)\s+([A-Za-z_]\w*)\s*\{\s*get\s*;\s*(?:set|init)\s*;\s*\}/;
// `public record User(...)` / `public record class User(...)` with a primary
// constructor (the `(` is required — a record without one uses auto-properties).
const RECORD_HEADER_RE = /\brecord\b(?:\s+(?:class|struct))?\s+[A-Za-z_]\w*\s*(?=\()/;
// `modelBuilder.Entity<Type>()` — the head of a Fluent API configuration chain.
const ENTITY_CALL_RE = /\b\w+\s*\.\s*Entity\s*<\s*([^>]+?)\s*>\s*\(/;
// A statement that configures a relationship (vs. Property/HasKey/ToTable/…),
// used to keep only relation chains inside an `IEntityTypeConfiguration<T>`.
const REL_VERB_RE = /\.\s*(?:HasOne|HasMany)\s*[(<]/;
// File-level guard: tokens that appear only in EF entity-configuration classes.
const CONFIG_MARKER_RE = /IEntityTypeConfiguration\s*<|EntityTypeBuilder\s*</;
// Folders whose classes are DTOs / view models / API contracts, never the
// persisted entity — so a same-named class there must NOT be tagged an entity
// by the cross-file reconcile. Matches path separators in either slash style.
const NON_ENTITY_PATH_RE =
  /[\/\\](?:ViewModels?|Dtos?|Contracts|Requests?|Responses?)[\/\\]/i;

// ── type classification ──────────────────────────────────────────────────

const SCALAR_TYPES = new Set<string>([
  "string", "int", "long", "short", "byte", "sbyte", "uint", "ulong", "ushort",
  "bool", "double", "float", "decimal", "guid", "datetime", "datetimeoffset",
  "dateonly", "timeonly", "timespan", "char", "object",
  // BCL-cased aliases.
  "string32", "int16", "int32", "int64", "uint16", "uint32", "uint64",
  "boolean", "single", "byte[]", "single32",
]);

const SCALAR_NAMES = new Set<string>([
  "String", "Int16", "Int32", "Int64", "UInt16", "UInt32", "UInt64",
  "Boolean", "Byte", "SByte", "Single", "Double", "Decimal", "Char",
  "Guid", "DateTime", "DateTimeOffset", "DateOnly", "TimeOnly", "TimeSpan",
  "Object",
]);

/** Non-entity types that are PascalCase but must never become relations. */
const TYPE_DENYLIST = new Set<string>([
  // Generic value containers.
  "Dictionary", "IDictionary", "IReadOnlyDictionary", "SortedDictionary",
  "Tuple", "ValueTuple", "KeyValuePair", "Nullable", "Lazy", "Span", "Memory",
  // JSON / dynamic payload types.
  "JsonElement", "JsonDocument", "JsonObject", "JsonArray", "JsonNode", "JsonValue",
  "JToken", "JObject", "JArray", "JValue", "JProperty",
  "XElement", "XDocument", "XmlDocument", "XmlElement", "Uri", "Type",
]);

const COLLECTION_RE = /^(?:System\.Collections\.Generic\.)?(?:I?Collection|I?List|List|IEnumerable|IReadOnlyCollection|IReadOnlyList|ISet|HashSet|ICollection|IList|SortedSet)\s*<\s*([^>]+?)\s*>$/;

/** Strip generics / nullable `?` / array `[]` / namespace, returning the bare identifier. */
function bareType(type: string | null | undefined): string {
  if (!type) return "";
  let t = type.trim();
  t = t.replace(/\?$/, "");      // nullable
  t = t.replace(/\[\]$/, "");    // array
  t = t.replace(/<.*$/, "");     // strip generic args
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  return t.trim();
}

/** If `type` is a (recognised) collection generic, return its inner type text. */
function collectionInner(type: string | null | undefined): string {
  if (!type) return "";
  const t = type.trim().replace(/\?$/, "");
  const m = COLLECTION_RE.exec(t);
  return m ? m[1].trim() : "";
}

/**
 * A generic type whose outer name is a non-entity container (Dictionary, Tuple,
 * KeyValuePair, …). These slip past COLLECTION_RE but must be treated as plain
 * value columns, never relations.
 */
function isNonEntityGeneric(type: string | null | undefined): boolean {
  if (!type) return false;
  const t = type.trim().replace(/\?$/, "");
  const m = /^([A-Za-z_][\w.]*)\s*</.exec(t);
  if (!m) return false;
  const outer = bareType(m[1]);
  // A recognised collection generic is handled elsewhere; here we only flag the
  // value containers / JSON payloads on the denylist.
  if (COLLECTION_RE.test(t)) return false;
  return TYPE_DENYLIST.has(outer);
}

/** A bare PascalCase type that should never be considered an entity relation. */
function isDenylistedType(bare: string): boolean {
  if (!bare) return false;
  if (TYPE_DENYLIST.has(bare)) return true;
  // Heuristic: JSON/dynamic payload type names.
  return /(?:Json|Element|Token|Payload)$/.test(bare) || /^J(?:Object|Array|Token)$/.test(bare);
}

function isNullable(type: string | null | undefined): boolean {
  if (!type) return false;
  const t = type.trim();
  return t.endsWith("?") || /^Nullable\s*</.test(t);
}

/** byte[] is a column (binary blob); Nullable<T> of a scalar is a scalar too. */
function isScalarRaw(type: string | null | undefined): boolean {
  if (!type) return false;
  const t = type.trim().replace(/\?$/, "");
  if (/^byte\[\]$/i.test(t)) return true;
  // Nullable<T> wrapper around a scalar.
  const nm = /^Nullable\s*<\s*([^>]+?)\s*>$/.exec(t);
  if (nm) return isScalar(bareType(nm[1]));
  return false;
}

function isScalar(bare: string): boolean {
  if (!bare) return false;
  if (SCALAR_NAMES.has(bare)) return true;
  return SCALAR_TYPES.has(bare.toLowerCase());
}

/** PascalCase, not a known scalar, not denylisted — could be an entity type. */
function isLikelyEntityType(bare: string): boolean {
  if (!bare) return false;
  if (isScalar(bare)) return false;
  if (isDenylistedType(bare)) return false;
  return /^[A-Z]/.test(bare);
}

/**
 * Resolve the EF-convention foreign key for a reference navigation property.
 * Precedence: explicit `[ForeignKey("X")]` → `<PropName>Id` sibling →
 * `<TypeName>Id` sibling → synthesized shadow FK `<PropName>Id` (INFERRED).
 * Returns the column, whether it came from an attribute (drives EXTRACTED vs
 * INFERRED), and whether it is a composite (comma-separated) key.
 */
function resolveForeignKey(
  member: Member,
  typeName: string,
  propNames: Set<string>,
): { column: string | null; fromAttribute: boolean; composite: boolean } {
  for (const attr of member.attributes) {
    const m = /\bForeignKey\s*\(\s*"([^"]+)"\s*\)/.exec(attr);
    if (m) {
      const col = m[1].trim();
      return { column: col, fromAttribute: true, composite: col.includes(",") };
    }
  }
  const byProp = `${member.name}Id`;
  if (propNames.has(byProp)) return { column: byProp, fromAttribute: false, composite: false };
  const byType = `${typeName}Id`;
  if (propNames.has(byType)) return { column: byType, fromAttribute: false, composite: false };
  // Shadow FK: EF synthesizes `<Nav>Id` even when not declared. Report it as an
  // INFERRED convention column so the FK is not invisible.
  return { column: byProp, fromAttribute: false, composite: false };
}

/** Extract a `[Column(..., TypeName="...")]` database type, if present. */
function columnTypeName(attributes: string[]): string | null {
  for (const attr of attributes) {
    const m = /\bColumn\s*\([^)]*\bTypeName\s*=\s*"([^"]+)"/i.exec(attr);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Map an NHibernate relation attribute to a cardinality. `[Bag]`/`[Set]`/
 * `[OneToMany]` → one-to-many; `[ManyToOne]` → many-to-one. Returns null when
 * no relation attribute is present.
 */
function nhibernateRelation(attributes: string[]): "one-to-many" | "many-to-one" | null {
  for (const attr of attributes) {
    if (/^\[\s*(Bag|Set|OneToMany)\b/i.test(attr)) return "one-to-many";
    if (/^\[\s*ManyToOne\b/i.test(attr)) return "many-to-one";
  }
  return null;
}

// ── Fluent-API lambda helpers ─────────────────────────────────────────────

/** From `p => p.Author` (or `p => p.AuthorId`) return the property name. */
function lambdaProperty(expr: string): string {
  if (!expr) return "";
  const s = expr.trim();
  // `x => x.Prop`
  const m = /=>\s*[A-Za-z_]\w*\s*\.\s*([A-Za-z_]\w*)/.exec(s);
  if (m) return m[1];
  // `"Prop"` string-based config.
  const sm = /^"([^"]+)"$/.exec(s);
  if (sm) return sm[1];
  return "";
}

/** From a lambda body `p => p.Author` infer the navigation's declared type
 * name is unknown; fall back to the property name as a best-effort entity. */
function navTypeFromLambda(expr: string): string {
  // We cannot know the static type from the lambda alone, so use the navigation
  // property name as the entity name (EF convention: nav name == entity name).
  const prop = lambdaProperty(expr);
  if (!prop) return "";
  // Strip a trailing plural 's' for collection navigations (Posts → Post).
  return prop.replace(/s$/, "");
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** Split `s` on top-level `sep`, ignoring separators inside <>/()/[] / strings. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      buf += ch;
      if (ch === "\\") { buf += s[++i] ?? ""; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === sep && depth === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/** True when two relations describe the same from→to edge on the same field. */
function sameRelation(a: EntityRelation, b: EntityRelation): boolean {
  return (
    a.fromEntity === b.fromEntity &&
    a.toEntity === b.toEntity &&
    a.fromField === b.fromField
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

// ─── Generic repository access (project-level) ──────────────────────────────

function* allCalls(a: FileAnalysis) {
  for (const f of a.functions ?? []) yield* f.calls ?? [];
  for (const c of a.classes ?? []) for (const m of c.methods ?? []) yield* m.calls ?? [];
}

/** `IBasicRepository<Movie>`, `IRepository<Order, int>`, `MovieStore<Movie>` → the first type argument. */
const REPOSITORY_GENERIC_RE = /^(?:[\w.]*\.)?I?\w*(?:Repository|Repo|Store|Dao)\w*\s*<\s*([\w.]+)/;
const REPOSITORY_VERB_RE =
  /^(Get|Find|All|Single|First|Query|Where|Count|Exists|Paged|Insert|Add|Update|Set|Upsert|Save|Delete|Remove|Purge|Clear)\w*$/;
const REPOSITORY_WRITE_RE = /^(Insert|Add|Update|Set|Upsert|Save|Delete|Remove|Purge|Clear)/;

/**
 * The repository pattern over a generic base — `IMovieRepository : IBasicRepository<Movie>`,
 * `MovieRepository : BasicRepository<Movie>` — puts the data access in a base
 * class whose type parameter is unknown there, so a service's
 * `_movieRepository.Get(id)` reached no entity (Radarr: 0 of 239 routes reached
 * the database). The entity is the type ARGUMENT, read where the member is
 * declared: a class member or constructor parameter whose declared type is, or
 * derives (across files) from, a `*Repository*<T>` / `*Store<T>` / `*Dao<T>`
 * whose `T` is a class the project declares. Every `member.Verb(…)` call with a
 * CRUD-shaped verb in that class then carries `T` as a `database` row.
 */
function attributeRepositoryAccesses(analyses: FileAnalysis[]): void {
  const cs = analyses.filter((a) => a.language === "csharp");
  const supertypes = new Map<string, string[]>();
  const classNames = new Set<string>();
  for (const a of cs) {
    for (const cls of a.classes ?? []) {
      classNames.add(cls.name);
      const written = [cls.extends ?? "", ...(cls.implements ?? [])].filter(Boolean);
      supertypes.set(cls.name, [...(supertypes.get(cls.name) ?? []), ...written]);
    }
  }
  if (classNames.size === 0) return;
  const cache = new Map<string, string | null>();
  const entityOfType = (type: string | null | undefined, depth = 0): string | null => {
    if (!type || depth > 6) return null;
    const written = type.trim();
    const direct = REPOSITORY_GENERIC_RE.exec(written);
    if (direct) {
      const arg = bareType(direct[1]);
      return arg && classNames.has(arg) ? arg : null;
    }
    const bare = bareType(written.replace(/<.*$/, ""));
    if (!bare) return null;
    if (cache.has(bare)) return cache.get(bare)!;
    cache.set(bare, null); // cycle guard
    let found: string | null = null;
    for (const sup of supertypes.get(bare) ?? []) {
      found = entityOfType(sup, depth + 1);
      if (found) break;
    }
    cache.set(bare, found);
    return found;
  };

  for (const a of cs) {
    const added: DataSourceInfo[] = [];
    const seen = new Set((a.dataSources ?? []).map((d) => `${d.line}\0${d.name}`));
    for (const cls of a.classes ?? []) {
      const members = new Map<string, string>();
      for (const p of cls.properties ?? []) {
        const e = entityOfType(p.type);
        if (e) members.set(p.name.replace(/^_/, ""), e);
      }
      for (const m of cls.methods ?? []) {
        if (m.name !== cls.name && m.name !== "constructor") continue;
        for (const p of m.params ?? []) {
          const e = entityOfType(p.type);
          if (e) members.set(p.name.replace(/^_/, ""), e);
        }
      }
      if (members.size === 0) continue;
      for (const m of cls.methods ?? []) {
        for (const call of m.calls ?? []) {
          const dot = call.name.indexOf(".");
          if (dot <= 0) continue;
          const head = call.name.slice(0, dot).replace(/^(?:this\.)?_?/, "");
          const leaf = call.name.slice(dot + 1);
          if (leaf.includes(".") || leaf.includes("(") || !REPOSITORY_VERB_RE.test(leaf)) continue;
          const entity = members.get(head);
          if (!entity) continue;
          const key = `${call.line}\0${call.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          added.push({
            kind: "database",
            name: call.name,
            target: entity,
            entity,
            access: REPOSITORY_WRITE_RE.test(leaf) ? "write" : "read",
            calls: [],
            line: call.line,
          });
        }
      }
    }
    if (added.length > 0) a.dataSources = [...(a.dataSources ?? []), ...added].sort((x, y) => x.line - y.line);
  }
}
