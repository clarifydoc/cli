import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, EntityRelation, FileAnalysis, Language, PropertyInfo } from "../../../types/analysis.js";
import { daoReceiverEntity, EVENT_TYPE_RE, GENERIC_EVENT_TYPE_RE } from "./data-sources.js";

/**
 * Extracts JPA entities + their relations from Java and Kotlin source.
 *
 * Covers the standard JPA annotation surface shared by Hibernate, EclipseLink
 * and OpenJPA (`@Entity`/`@Table`/`@Column`/`@Id`/`@ManyToOne`/`@OneToMany`/…),
 * plus Spring Data JDBC's `@Table` + `@MappedCollection` style, plus JPA value
 * types (`@Embeddable`/`@Embedded`/`@ElementCollection`) and inheritance
 * (`@Inheritance`/`@DiscriminatorColumn`/`@DiscriminatorValue`).
 *
 * Works on class-body source text (re-scanned via `bodyOf`) because
 * PropertyInfo carries no decorator info. Multiline annotations — annotations
 * whose argument list spans several physical lines, with nested `@JoinColumn`
 * structures, comments, and string literals — are handled by the shared
 * `decoratedMembers`/`logicalLines` primitives on the base class, so we no
 * longer drop them as the previous line-by-line scanner did.
 *
 * Never throws — every member is parsed inside a try/catch and skipped on
 * failure, and the whole extraction is wrapped defensively.
 */
export class JavaKotlinEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  /** Java/Kotlin both use C-style `//` line comments. */
  private static readonly COMMENT = ["//"] as const;

  /**
   * A named query runs where its name is used (`em.createNamedQuery("match.byClub")`)
   * and is declared on an entity (`@NamedQuery(name = "match.byClub", query = "select
   * m from Match m …")`): the call reads what the query's `from` names, else the
   * declaring entity. A name two declarations disagree on names nothing.
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const jvm = analyses.filter((a) => a.language === "java" || a.language === "kotlin");
    statedRepositoryEntities(jvm);
    implementedDaoTables(jvm);
    projectDaoMethodCalls(jvm);
    handedEntityAccess(jvm);
    helperPublishedEvents(jvm);
    const byName = namedQueryEntities(analyses);
    if (byName.size === 0) return;
    for (const a of jvm) {
      for (const ds of a.dataSources ?? []) {
        const query = ds.namedQuery && !ds.entity ? byName.get(ds.namedQuery) : null;
        if (!query) continue;
        ds.entity = query.entity;
        ds.target ??= query.entity;
        ds.access ??= query.access;
      }
      addHelperQueryRuns(a, byName);
    }
  }

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    try {
      const springDataJdbc = this.usesSpringDataJdbc(ctx);

      for (const cls of ctx.analysis.classes ?? []) {
        try {
          const body = this.bodyOf(ctx, cls);

          // jOOQ generated table class: `class X extends TableImpl<XRecord>` with
          // `createField(name("col"), SQLDataType.TYPE…)` columns. For jOOQ
          // projects the *entire* schema lives in these generated sources (the
          // tables) plus `Keys.java` (the foreign keys, handled after the loop) —
          // there are no JPA annotations to find.
          if (this.isJooqTable(cls, body)) {
            const cols = this.extractJooqColumns(body);
            if (cols.length > 0) {
              entities.push(
                this.entity({
                  name: cls.name,
                  orm: "jooq",
                  properties: cols,
                  extends: cls.extends ?? null,
                  line: cls.line,
                  endLine: cls.endLine,
                }),
              );
            }
            continue;
          }

          const kind = this.entityKind(ctx, cls, body);
          if (!kind) continue; // not an entity / embeddable — skip entirely.

          const orm =
            springDataJdbc && this.hasMappedCollection(body) ? "spring-data-jdbc" : "jpa";

          // Isolate the member region — the text between the class's own braces
          // (Java/Kotlin block body) AND the text inside a Kotlin primary
          // constructor's parens (`data class X(@Id val id: ...)`). `bodyOf`
          // hands us the class header + braces, and `logicalLines` would
          // otherwise collapse the WHOLE class into one statement (the outer
          // `{` only closes on the final `}`), so we must strip the wrapper.
          const memberRegion = this.memberRegion(body, cls.name);

          // Group stacked / inline / multiline annotations with their member.
          const members = this.decoratedMembers(memberRegion, {
            style: "at",
            lineComment: JavaKotlinEntityExtractor.COMMENT,
          });

          const properties: PropertyInfo[] = [];
          const targets = new Set<string>();
          // Property names present on the entity — used for FK conventions and
          // for `@PrimaryKeyJoinColumn` default-name derivation.

          for (const member of members) {
            try {
              const field = this.parseField(member.declaration);
              if (!field) continue; // method, ctor, computed/delegated prop, etc.
              const ann = member.decorators;

              // `@Transient` (and the `transient` Java keyword) are never persisted.
              if (this.hasAnnotation(ann, "Transient") || /\btransient\b/.test(member.declaration)) {
                continue;
              }

              const rel = this.relationFor(cls.name, field, ann, orm);
              if (rel) {
                relations.push(rel);
                targets.add(rel.toEntity);
                continue; // an association is not also a scalar column.
              }

              // Not an association. Persisted columns are those with an explicit
              // ORM marker (`@Column`/`@Id`/`@EmbeddedId`) or an embedded value
              // type (`@Embedded`/`@ElementCollection`). Anything else (computed
              // Kotlin `val`, helper state, loggers) is treated as transient.
              if (this.isPersistedColumn(ann)) {
                // The property keeps the Java/Kotlin field name (what downstream
                // consumers match on) and the declared type; an explicit
                // `@Column(name = "col")` / Kotlin `@Column("col")` is its physical
                // column, and `@Id` / `@EmbeddedId` its primary key.
                const prop = this.column(field.name, field.type);
                const physical = columnNameOf(ann);
                if (physical && physical !== field.name) prop.column = physical;
                if (this.hasAnnotation(ann, "Id") || this.hasAnnotation(ann, "EmbeddedId")) prop.primaryKey = true;
                properties.push(prop);
              }
            } catch {
              // Skip any member we cannot parse cleanly; keep going.
            }
          }

          // Inheritance / discriminator metadata becomes entity decorators so a
          // downstream consumer can see the hierarchy strategy without re-parsing.
          const extraDecorators = this.inheritanceDecorators(kind, ctx, cls, body);

          entities.push(
            this.entity({
              name: cls.name,
              orm,
              properties,
              implementsList: [...targets],
              extends: cls.extends ?? null,
              line: cls.line,
              endLine: cls.endLine,
              extraDecorators,
              tableName: jpaTableName(cls.decorators, ctx.sourceText ?? "", cls.name),
            }),
          );
        } catch {
          // Skip an unparseable class; continue with the rest.
        }
      }

      // jOOQ `Keys.java`: a central file of `Internal.createForeignKey(...)`
      // constants encoding every FK. Parse them into many-to-one relations
      // between the (cross-file) table entities.
      for (const rel of this.extractJooqForeignKeys(ctx)) relations.push(rel);
    } catch {
      // Never throw from an extractor — return whatever we collected.
    }

    return { entities, relations };
  }

  // ─── jOOQ generated code (tables + Keys) ──────────────────────────────────

  /** True for a jOOQ generated/hand-written table: `… : TableImpl<…>` / `extends TableImpl<…>`. */
  private isJooqTable(cls: ClassInfo, body: string[]): boolean {
    if ((cls.extends ?? "").includes("TableImpl")) return true;
    // The declaration may carry the generic on the same or next line.
    return /\bTableImpl\s*</.test(body.slice(0, 4).join("\n"));
  }

  /**
   * Columns of a jOOQ table from its `createField(name("col"), SQLDataType.TYPE…)`
   * declarations. An `.identity(true)` modifier marks the auto-increment primary
   * key — encoded as ` @id` on the type so the ER graph flags it (mirrors Prisma).
   */
  private extractJooqColumns(body: string[]): PropertyInfo[] {
    const text = body.join("\n");
    const cols: PropertyInfo[] = [];
    const seen = new Set<string>();
    const re =
      /createField\(\s*(?:DSL\.)?name\(\s*"([^"]+)"\s*\)\s*,\s*(?:org\.jooq\.impl\.)?SQLDataType\.([A-Za-z0-9_]+)((?:\s*\([^)]*\))?(?:\s*\.[A-Za-z]+\s*\([^)]*\))*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      let type = m[2]!;
      if (/\.identity\(\s*true\s*\)/.test(m[3] ?? "")) type += " @id";
      cols.push(this.column(name, type));
    }
    return cols;
  }

  /**
   * Parse jOOQ `Internal.createForeignKey(Child.X, name("…"), new TableField[]{
   * Child.X.FKCOL }, Keys.KEY_PARENT_PRIMARY, new TableField[]{ Parent.Y.PKCOL })`
   * into many-to-one relations (Child → Parent). Composite FKs use the first
   * column. Only fires on files that actually define foreign keys (Keys.java).
   */
  private extractJooqForeignKeys(ctx: EntityExtractContext): EntityRelation[] {
    const text = ctx.sourceText ?? "";
    if (!text.includes("createForeignKey")) return [];
    const out: EntityRelation[] = [];
    const seen = new Set<string>();
    const re =
      /createForeignKey\(\s*([A-Za-z_]\w*)\.[A-Za-z_]\w*\s*,\s*(?:DSL\.)?name\([^)]*\)\s*,\s*new\s+TableField\s*(?:<[^>]*>)?\s*\[\]\s*\{\s*([A-Za-z_]\w*)\.[A-Za-z_]\w*\.([A-Za-z_]\w*)[^}]*\}\s*,\s*[^,]+,\s*new\s+TableField\s*(?:<[^>]*>)?\s*\[\]\s*\{\s*([A-Za-z_]\w*)\.[A-Za-z_]\w*\.([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const child = m[1]!;
      const fkCol = m[3]!;
      const parent = m[4]!;
      const key = `${child}|${fkCol}|${parent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        fromEntity: child,
        fromField: fkCol,
        toEntity: parent,
        cardinality: "many-to-one",
        foreignKey: fkCol,
        orm: "jooq",
        confidence: "EXTRACTED",
      });
    }
    return out;
  }

  /**
   * Extract the member-declaration lines for a class from its `bodyOf` slice.
   * Returns lines suitable for `decoratedMembers`:
   *   - Kotlin primary-constructor params (between the `(` after `class X` and
   *     its matching `)`), each top-level comma-separated param on its own line.
   *   - The block body (between the class's first top-level `{` and its match),
   *     preserved line-by-line so multiline annotations re-balance correctly.
   * Stripping the wrapping braces is essential: otherwise `logicalLines` sees
   * the unbalanced class-opening `{` and folds the entire class into one entry.
   */
  private memberRegion(body: string[], className: string): string[] {
    const out: string[] = [];
    const text = body.join("\n");

    // Locate the class declaration so we scan only its own constructor/body,
    // not annotations or nested members that happen to share a name.
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declRe = new RegExp(`\\b(?:class|interface|enum)\\s+${escaped}\\b`);
    const declMatch = declRe.exec(text);
    const from = declMatch ? declMatch.index + declMatch[0].length : 0;

    // Walk from the declaration, tracking the first top-level `(` (Kotlin
    // primary constructor) and the first top-level `{` (block body).
    let depth = 0;
    let quote = "";
    let ctorOpen = -1;
    let braceOpen = -1;
    for (let i = from; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(") { if (depth === 0 && ctorOpen < 0 && braceOpen < 0) ctorOpen = i; depth++; continue; }
      if (ch === "{") { if (depth === 0) { braceOpen = i; break; } depth++; continue; }
      if (ch === ")" || ch === "}") { depth--; continue; }
    }

    // Kotlin primary constructor params → one logical line each.
    if (ctorOpen >= 0) {
      const close = this.matchBracket(text, ctorOpen);
      if (close > ctorOpen) {
        const params = this.splitTopLevel(text.slice(ctorOpen + 1, close));
        for (const p of params) {
          const trimmed = p.trim();
          if (trimmed) out.push(trimmed);
        }
      }
    }

    // Block body lines (between matching braces), preserved per physical line.
    const bodyStart = braceOpen >= 0 ? braceOpen : text.indexOf("{", from);
    if (bodyStart >= 0) {
      const close = this.matchBracket(text, bodyStart);
      const inner = text.slice(bodyStart + 1, close > bodyStart ? close : undefined);
      for (const line of inner.split("\n")) out.push(line);
    }

    return out;
  }

  /** Index of the `>` matching the `<` at `openIdx` (string-aware; nests `<>`). */
  private matchAngle(s: string, openIdx: number): number {
    if (s[openIdx] !== "<") return -1;
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
      if (ch === "<") depth++;
      else if (ch === ">") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /** Split a string on top-level commas (ignoring those inside (), [], {}, <>, strings). */
  private splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
      else if (ch === "," && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    parts.push(s.slice(start));
    return parts;
  }

  // ─── Entity / value-type detection ──────────────────────────────────────

  /**
   * Classify a class as a persisted `"entity"`, a value-type `"embeddable"`, or
   * `null` (not persisted — skip it). We only treat a class as persisted when it
   * carries a genuine ORM marker so plain POJOs/DTOs/data classes don't produce
   * false-positive entities. Detection sources, in order:
   *   1) decorators recorded by the class extractor,
   *   2) annotations on the logical lines above the class declaration in `body`,
   *   3) the ~5 raw lines immediately above `cls.line` (covers missing-body cases).
   */
  private entityKind(
    ctx: EntityExtractContext,
    cls: ClassInfo,
    body: string[],
  ): "entity" | "embeddable" | null {
    const decorators = cls.decorators ?? [];
    if (this.hasAnnotation(decorators, "Embeddable")) return "embeddable";
    if (
      this.hasAnnotation(decorators, "Entity") ||
      this.hasAnnotation(decorators, "Table") ||
      this.hasAnnotation(decorators, "MappedSuperclass")
    ) {
      return "entity";
    }

    // Scan the annotations that precede the class declaration. Use logical
    // lines so a multiline `@Table(...)` is collapsed into one entry, and stop
    // once we reach the `class X` declaration so member annotations don't leak.
    const logical = this.logicalLines(body, { lineComment: JavaKotlinEntityExtractor.COMMENT });
    for (const ll of logical) {
      if (this.isClassDecl(ll.text, cls.name)) break;
      if (/@(?:[\w.]*\.)?Embeddable\b/.test(ll.text)) return "embeddable";
      if (/@(?:[\w.]*\.)?(?:Entity|Table|MappedSuperclass)\b/.test(ll.text)) return "entity";
    }

    // Raw-line fallback: the ~5 lines immediately above the declaration.
    const declLine = cls.line - 1; // 0-based
    const lines = ctx.lines ?? [];
    for (let i = Math.max(0, declLine - 5); i < declLine && i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (/@(?:[\w.]*\.)?Embeddable\b/.test(line)) return "embeddable";
      if (/@(?:[\w.]*\.)?(?:Entity|Table|MappedSuperclass)\b/.test(line)) return "entity";
    }
    return null;
  }

  /** True when `line` declares `class <name>` (handles Java/Kotlin modifiers). */
  private isClassDecl(line: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `\\b(?:public\\s+|private\\s+|protected\\s+|open\\s+|data\\s+|abstract\\s+|final\\s+|sealed\\s+|inner\\s+|static\\s+)*(?:class|interface|enum)\\s+${escaped}\\b`,
    ).test(line);
  }

  private usesSpringDataJdbc(ctx: EntityExtractContext): boolean {
    return (ctx.analysis.imports ?? []).some(
      (imp) =>
        imp.source.includes("org.springframework.data.relational") ||
        imp.source.includes("org.springframework.data.jdbc"),
    );
  }

  private hasMappedCollection(body: string[]): boolean {
    return body.some((l) => /@MappedCollection\b/.test(l));
  }

  /**
   * Build `extraDecorators` describing inheritance strategy / discriminator for
   * an entity, scanning the annotations above the class declaration. Returns an
   * empty array for embeddables or when none are present.
   */
  private inheritanceDecorators(
    kind: "entity" | "embeddable",
    ctx: EntityExtractContext,
    cls: ClassInfo,
    body: string[],
  ): string[] {
    const out: string[] = [];
    if (kind === "embeddable") return ["embeddable"];

    // Collect candidate annotation text from class decorators + the lines above.
    const candidates: string[] = [...(cls.decorators ?? [])];
    const logical = this.logicalLines(body, { lineComment: JavaKotlinEntityExtractor.COMMENT });
    for (const ll of logical) {
      if (this.isClassDecl(ll.text, cls.name)) break;
      candidates.push(ll.text);
    }
    const declLine = cls.line - 1;
    const lines = ctx.lines ?? [];
    for (let i = Math.max(0, declLine - 5); i < declLine && i < lines.length; i++) {
      if (lines[i]) candidates.push(lines[i]);
    }
    const blob = candidates.join("\n");

    // A `@MappedSuperclass` maps no table of its own: its columns are its entity subclasses'.
    const marked = (name: string) => (cls.decorators ?? []).some((d) => new RegExp(`^@?(?:[\\w.]*\\.)?${name}\\b`).test(d)) ||
      new RegExp(`@(?:[\\w.]*\\.)?${name}\\b`).test(blob);
    if (marked("MappedSuperclass") && !marked("Entity")) out.push("abstract");

    const inh = blob.match(/@(?:[\w.]*\.)?Inheritance\b[\s\S]*?strategy\s*=\s*(?:InheritanceType\.)?(\w+)/);
    if (inh) out.push(`inheritance:${inh[1].toLowerCase().replace(/_/g, "-")}`);

    const disc = blob.match(/@(?:[\w.]*\.)?DiscriminatorColumn\b[\s\S]*?name\s*=\s*"([^"]+)"/);
    if (disc) out.push(`discriminator:${disc[1]}`);

    const dv = blob.match(/@(?:[\w.]*\.)?DiscriminatorValue\s*\(\s*"([^"]+)"\s*\)/);
    if (dv) out.push(`discriminator-value:${dv[1]}`);

    return out;
  }

  // ─── Member field parsing ───────────────────────────────────────────────

  /**
   * Parse a member declaration into name + bare type + optional explicit
   * column name. Handles:
   *   - Kotlin: `[modifiers] val|var name: Type[?] [= default]`
   *   - Java:   `[modifiers] Type name [= ...];`  (modifiers optional, so
   *             package-private `Long id;` is accepted too)
   *
   * Returns null for methods, constructors, Kotlin computed (`get()`) and
   * delegated (`by`) properties, companion-object consts, and anything else
   * that isn't a plain field declaration.
   */
  private parseField(decl: string): ParsedField | null {
    let s = decl.trim();
    if (!s) return null;

    // Drop a trailing default initializer / body so it doesn't confuse the
    // type parse (`val createdAt: Instant = Instant.now()` → `val createdAt: Instant`).
    // Keep the `=` only long enough to know it exists; we cut at the first
    // top-level `=` that isn't part of `==`/`>=`/`<=`/`!=`.
    s = this.stripInitializer(s);

    // Skip Kotlin computed / delegated properties — no persistent backing field.
    if (/\bby\b/.test(s)) return null;
    if (/\bget\s*\(\s*\)/.test(s) || /\bset\s*\(/.test(s)) return null;

    // Skip obvious method declarations: `... name(...) ...`.
    if (/\b[A-Za-z_]\w*\s*\([^)]*\)/.test(s) && !/\b(?:val|var)\b/.test(s)) {
      // A Java field never has a `(` before the terminating `;`/`{`.
      if (!/:\s*/.test(s)) return null;
    }

    // Kotlin: [modifiers] val|var name: Type
    const kotlin = s.match(/\b(?:val|var)\s+([A-Za-z_]\w*)\s*:\s*([^=;{]+)/);
    if (kotlin) {
      const type = kotlin[2].trim();
      return { name: kotlin[1], type, optional: /\?\s*$/.test(type) };
    }
    // Kotlin constructor param without val/var is NOT a persisted property —
    // those are reachable only via the constructor, never as columns. We skip
    // them by only matching `val`/`var` above. Companion `const val` is also
    // skipped because `const` consts are static and not table columns:
    if (/\bconst\b/.test(decl)) return null;

    // Java: [modifiers] Type name; — modifiers are OPTIONAL so package-private
    // fields (`Long id;`) are accepted. We require the line to look like a
    // field (ends in `;`, `=`, or has no parens) to avoid matching methods.
    if (/[;=]/.test(s) || !/[(){}]/.test(s)) {
      const java = s.match(
        /^(?:(?:public|protected|private|final|static|transient|volatile|abstract)\s+)*([A-Za-z_][\w.]*(?:\s*<[\s\S]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_]\w*)\s*[;=]?\s*$/,
      );
      if (java) {
        return { name: java[2], type: java[1].trim(), optional: false };
      }
    }

    return null;
  }

  /** Cut a declaration at its top-level assignment, preserving the LHS. */
  private stripInitializer(s: string): string {
    let depth = 0;
    let quote = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
      else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
      else if (
        ch === "=" && depth <= 0 &&
        s[i + 1] !== "=" && s[i - 1] !== "=" &&
        s[i - 1] !== "!" && s[i - 1] !== "<" && s[i - 1] !== ">"
      ) {
        return s.slice(0, i).trim();
      }
    }
    return s.replace(/;\s*$/, "").trim();
  }

  /** A member is a persisted scalar/value column when it carries one of these. */
  private isPersistedColumn(ann: string[]): boolean {
    return (
      this.hasAnnotation(ann, "Column") ||
      this.hasAnnotation(ann, "Id") ||
      this.hasAnnotation(ann, "EmbeddedId") ||
      this.hasAnnotation(ann, "Embedded") ||
      this.hasAnnotation(ann, "ElementCollection") ||
      this.hasAnnotation(ann, "Version") ||
      this.hasAnnotation(ann, "Lob") ||
      this.hasAnnotation(ann, "Enumerated")
    );
  }

  // ─── Relation extraction ────────────────────────────────────────────────

  /**
   * Resolve a field type to its related-entity name. Handles collection
   * wrappers the base `coreType` doesn't (Java `Stream`/`Queue`/`Deque`/
   * `Vector`, Kotlin `Sequence`/`Flow`/`MutableList`/`MutableSet`) and strips
   * generic wildcard bounds (`? extends Post` → `Post`, `Collection<?>` → null)
   * before delegating to `coreType` for the standard wrappers / dotted names.
   */
  private relationTarget(type: string | null): string | null {
    if (!type) return null;
    let t = type.trim().replace(/\?\s*$/, ""); // Kotlin nullable on the whole field
    // Peel any single-parameter generic wrapper (`List<…>`, `Stream<…>`,
    // `Map<K,V>` → value, etc.) using bracket-aware `<>` matching, taking the
    // LAST type argument so nested generics (`List<Pair<Long, Post>>`) and maps
    // resolve correctly. This covers BOTH the wrappers `coreType` knows and the
    // extra Java/Kotlin collection types it doesn't, and lets us strip wildcard
    // bounds that would otherwise confuse `coreType`'s identifier grab.
    for (let guard = 0; guard < 8; guard++) {
      const open = t.indexOf("<");
      if (open < 0) break;
      // Only peel when everything before `<` is a single (possibly dotted) name.
      if (!/^[\w.]+\s*$/.test(t.slice(0, open))) break;
      const close = this.matchAngle(t, open); // `matchBracket` doesn't handle `<>`
      if (close < 0) break;
      const args = this.splitTopLevel(t.slice(open + 1, close));
      let next = (args[args.length - 1] ?? "").trim();
      // Strip wildcard bounds: `? extends Post`/`? super Post` → `Post`; bare `?` → null.
      const wild = next.match(/^\?\s*(?:extends|super)\s+(.+)$/);
      if (wild) next = wild[1].trim();
      if (next === "?" || next === "") return null;
      t = next;
    }
    if (t === "?" || t === "") return null;
    return this.coreType(t);
  }

  /**
   * Build an `EntityRelation` from a relation annotation, or null when the
   * member is not an association. `@Embedded`/`@ElementCollection` are value
   * types, never relations, so they are explicitly NOT handled here.
   */
  private relationFor(
    fromEntity: string,
    field: ParsedField,
    ann: string[],
    orm: string,
  ): EntityRelation | null {
    let cardinality: EntityRelation["cardinality"] | null = null;
    let kindMarker: RegExp | null = null;

    if (this.hasAnnotation(ann, "ManyToOne")) {
      cardinality = "many-to-one";
      kindMarker = /@(?:[\w.]*\.)?ManyToOne\b/;
    } else if (this.hasAnnotation(ann, "OneToMany")) {
      cardinality = "one-to-many";
      kindMarker = /@(?:[\w.]*\.)?OneToMany\b/;
    } else if (this.hasAnnotation(ann, "OneToOne")) {
      cardinality = "one-to-one";
      kindMarker = /@(?:[\w.]*\.)?OneToOne\b/;
    } else if (this.hasAnnotation(ann, "ManyToMany")) {
      cardinality = "many-to-many";
      kindMarker = /@(?:[\w.]*\.)?ManyToMany\b/;
    } else if (this.hasAnnotation(ann, "MappedCollection")) {
      // Spring Data JDBC: a mapped collection is a one-to-many aggregate.
      cardinality = "one-to-many";
      kindMarker = /@(?:[\w.]*\.)?MappedCollection\b/;
    }

    if (!cardinality || !kindMarker) return null;

    // Target entity: explicit `targetEntity = X.class` wins, otherwise infer
    // from the (collection-unwrapped) field type. Skip primitives / scalars and
    // wildcard-only generics — those are never associations.
    const targetEntity = this.annotationArg(ann, kindMarker, "targetEntity");
    let toEntity =
      (targetEntity ? this.coreType(targetEntity) : null) ?? this.relationTarget(field.type);

    let confidence: EntityRelation["confidence"] = "EXTRACTED";
    if (!toEntity || isScalarType(toEntity)) {
      // A relation annotation on a scalar/String field is a mistake or proxy we
      // can't resolve — emitting it would be a false positive, so skip it.
      return null;
    }
    // A bare `?` wildcard (`Collection<?>`) yields no usable target name.
    if (toEntity === "?" || /^\?/.test(toEntity)) return null;
    // Inferred (not explicitly declared) target → lower confidence.
    if (!targetEntity) confidence = "INFERRED";

    const relation: EntityRelation = {
      fromEntity,
      fromField: field.name,
      toEntity,
      cardinality,
      orm,
      confidence,
    };

    // Inverse side: `mappedBy` names the owning field on the target entity.
    const inverse = this.annotationArg(
      ann,
      /@(?:[\w.]*\.)?(?:OneToMany|OneToOne|ManyToMany)\b/,
      "mappedBy",
    );
    if (inverse) relation.inverseField = inverse;

    // Foreign key: `@JoinColumn(name=...)`, Spring Data JDBC `@MappedCollection
    // (idColumn=...)`, or — for a shared-PK one-to-one — `@PrimaryKeyJoinColumn`
    // (no name → derive `<inverse|field>_id` by convention; the inverse/`mappedBy`
    // name reflects the owning side, so prefer it when present).
    // Anchor the JoinColumn marker to the START of the annotation string so a
    // nested `@JoinColumn` INSIDE a `@JoinTable(joinColumns = @JoinColumn(...))`
    // doesn't get selected (which wrongly set the FK to the join-table name).
    let fk =
      this.annotationArg(ann, /^\s*@(?:[\w.]*\.)?JoinColumn\b/, "name") ??
      this.annotationArg(ann, /^\s*@(?:[\w.]*\.)?MappedCollection\b/, "idColumn");
    let fkExtracted = fk != null;
    if (!fk && this.hasAnnotation(ann, "PrimaryKeyJoinColumn")) {
      const named = this.annotationArg(ann, /@(?:[\w.]*\.)?PrimaryKeyJoinColumn\b/, "name");
      const conventionBase = relation.inverseField ?? field.name;
      fk = named ?? `${toSnake(conventionBase)}_id`;
      fkExtracted = named != null;
    }
    if (fk) relation.foreignKey = fk;
    // If the FK is only convention-derived (not explicitly named) and there's no
    // explicit target either, the relation is convention-inferred.
    if (!fkExtracted && confidence === "INFERRED") relation.confidence = "INFERRED";

    // Join table: `@JoinTable(name=...)` for many-to-many, or Spring Data JDBC
    // `@MappedCollection(table=...)`. Record the named pivot table.
    const joinTable =
      this.annotationArg(ann, /@(?:[\w.]*\.)?JoinTable\b/, "name") ??
      this.annotationArg(ann, /@(?:[\w.]*\.)?MappedCollection\b/, "table");
    if (joinTable) relation.joinTable = joinTable;

    // Optionality: explicit `optional=true|false` on the annotation wins;
    // otherwise a Kotlin nullable `?` on the field type marks it optional.
    const optional = this.optionalityOf(ann, field, kindMarker);
    if (optional !== undefined) relation.optional = optional;

    return relation;
  }

  /**
   * Optionality precedence: an explicit `optional = true|false` on the relation
   * annotation, else `@JoinColumn(nullable = true|false)`, else a Kotlin
   * nullable field type. Returns undefined when nothing is declared.
   */
  private optionalityOf(
    ann: string[],
    field: ParsedField,
    kindMarker: RegExp,
  ): boolean | undefined {
    const optArg = this.annotationArg(ann, kindMarker, "optional");
    if (optArg === "true" || optArg === "false") return optArg === "true";
    const nullable = this.annotationArg(ann, /@(?:[\w.]*\.)?JoinColumn\b/, "nullable");
    if (nullable === "true" || nullable === "false") return nullable === "true";
    if (field.optional) return true;
    return undefined;
  }

  // ─── Annotation helpers ─────────────────────────────────────────────────

  /** True when any annotation in the list is `@<pkg.>Name`. */
  private hasAnnotation(annotations: string[], name: string): boolean {
    const re = new RegExp(`@(?:[\\w.]*\\.)?${name}\\b`);
    return annotations.some((a) => re.test(a));
  }

  /**
   * Read a named argument from the first annotation matching `marker`. Handles,
   * in this order of preference inside the argument list:
   *   - quoted string:   `name = "author_id"`          → `author_id`
   *   - class reference: `targetEntity = Author.class`  → `Author`
   *   - enum constant:   `fetch = FetchType.LAZY`       → `LAZY`
   *   - boolean / bare:  `optional = false`             → `false`
   *
   * Argument extraction is bracket-/string-aware (via `matchBracket`) so a
   * nested `@JoinColumn(...)`, a `"VARCHAR(255)"` columnDefinition, or a
   * `columnNames = {"a","b"}` set does not confuse the scan. Multiline
   * annotations were already collapsed into one string by `decoratedMembers`.
   */
  private annotationArg(annotations: string[], marker: RegExp, arg: string): string | null {
    for (const a of annotations) {
      if (!marker.test(a)) continue;
      const value = this.readArg(a, arg);
      if (value != null) return value;
    }
    return null;
  }

  /**
   * Extract the value of `arg` from a single annotation string. Scans for
   * `arg =` at the annotation's TOP bracket level (so a `name` inside a nested
   * `@JoinColumn(name=...)` doesn't shadow the outer one), then reads the value
   * token respecting strings, braces, and nested parens.
   */
  private readArg(annotation: string, arg: string): string | null {
    // Find the annotation's own argument list `( ... )`.
    const open = annotation.indexOf("(");
    if (open < 0) return null;
    const close = this.matchBracket(annotation, open);
    const body = close > open ? annotation.slice(open + 1, close) : annotation.slice(open + 1);

    const argRe = new RegExp(`(^|[\\s,(])${arg}\\s*=\\s*`, "g");
    let depth = 0;
    let quote = "";
    // Walk to find an `arg =` occurrence that sits at top level of `body`.
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
      if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
      if (depth !== 0) continue;
      argRe.lastIndex = i;
      const m = argRe.exec(body);
      if (m && m.index === i) {
        const valueStart = i + m[0].length;
        return this.readValue(body.slice(valueStart));
      }
    }
    return null;
  }

  /** Read and normalize a single argument value from the head of `s`. */
  private readValue(s: string): string | null {
    let t = s.replace(/^\s+/, "");
    if (!t) return null;

    // Quoted string literal → its contents.
    if (t[0] === '"' || t[0] === "'") {
      const q = t[0];
      let out = "";
      for (let i = 1; i < t.length; i++) {
        if (t[i] === "\\") { out += t[i + 1] ?? ""; i++; continue; }
        if (t[i] === q) break;
        out += t[i];
      }
      return out;
    }

    // Otherwise read up to the next top-level `,` or end-of-args.
    let depth = 0;
    let end = t.length;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) { end = i; break; } depth--; }
      else if (ch === "," && depth === 0) { end = i; break; }
    }
    let raw = t.slice(0, end).trim();
    if (!raw) return null;

    // `Author.class` → `Author`; `FetchType.LAZY` → `LAZY`; `CascadeType.ALL` → `ALL`.
    raw = raw.replace(/\.class\s*$/, "");
    const dot = raw.lastIndexOf(".");
    if (dot >= 0 && /^[A-Za-z_][\w.]*$/.test(raw)) raw = raw.slice(dot + 1);
    return raw || null;
  }
}

/** A parsed field/property declaration. */
/** The physical column a JPA member annotation names: `@Column(name = "col")`, `@Column("col")` (Spring Data). */
function columnNameOf(ann: readonly string[]): string | null {
  for (const a of ann) {
    const m = /^@?(?:[\w.]*\.)?Column\s*\(([\s\S]*)\)\s*$/.exec(a.trim());
    if (!m) continue;
    const named = /\bname\s*=\s*"([^"]+)"/.exec(m[1]!) ?? /^\s*(?:value\s*=\s*)?"([^"]+)"/.exec(m[1]!);
    if (named) return named[1]!.replace(/^[`"[]|[`"\]]$/g, "");
  }
  return null;
}

interface ParsedField {
  name: string;
  /** Raw type text (e.g. `List<Comment>`, `Author?`). */
  type: string;
  /** Kotlin nullable `?` on the field type. */
  optional: boolean;
}

// ─── Type classification ───────────────────────────────────────────────────

/** Java/Kotlin scalar & common stdlib types that are never entity associations. */
const SCALAR_TYPES = new Set<string>([
  // Java primitives + boxed.
  "byte", "short", "int", "long", "float", "double", "boolean", "char",
  "Byte", "Short", "Integer", "Long", "Float", "Double", "Boolean", "Character",
  "String", "CharSequence", "Object", "Number", "BigDecimal", "BigInteger",
  "UUID", "Void",
  // Date / time.
  "Date", "Time", "Timestamp", "Instant", "LocalDate", "LocalTime", "LocalDateTime",
  "OffsetDateTime", "ZonedDateTime", "Duration", "Period", "Calendar",
  // Kotlin scalars.
  "Int", "Char", "Unit", "Any", "Nothing",
  // Common value-ish blobs.
  "Blob", "Clob", "URI", "URL", "Locale", "Currency",
]);

/** True for a bare type name that is a primitive / stdlib scalar, not an entity. */
function isScalarType(bare: string | null): boolean {
  if (!bare) return false;
  return SCALAR_TYPES.has(bare);
}

/** Convert a camelCase / PascalCase identifier to snake_case (for FK defaults). */
function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** `@Table(name = "app_users")`, `@Table("app_users")` (Spring Data JDBC), `@Table(schema = "s", name = "t")`. */
function jpaTableName(decorators: readonly string[], sourceText: string, className: string): string | null {
  for (const d of decorators) {
    const m = /^@?(?:[\w.]+\.)?Table\s*\(([\s\S]*)\)\s*$/.exec(d.trim());
    if (!m) continue;
    // The table's own attributes: a nested `@UniqueConstraint(name = "uk_x")` or `@Index(name = …)` names something else.
    let own = m[1]!;
    for (let prev = ""; prev !== own;) {
      prev = own;
      own = own.replace(/@[\w.]+\s*\([^()]*\)|\{[^{}]*\}|\[[^[\]]*\]/g, "");
    }
    m[1] = own;
    const named = /\b(?:name|value)\s*=\s*"([^"]+)"/.exec(m[1]!) ?? /^\s*"([^"]+)"/.exec(m[1]!);
    if (named) return named[1]!;
    // `@Table(name = EntityClub.TABLE)` with `public static final String TABLE = "clubs";`
    // (Kotlin `const val TABLE = "clubs"`) in this file.
    const ref = /\b(?:name|value)\s*=\s*(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(m[1]!) ?? /^\s*(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\s*$/.exec(m[1]!);
    if (ref && (!ref[1] || ref[1] === className || new RegExp(`\\b(?:class|interface|object)\\s+${ref[1]}\\b`).test(sourceText))) {
      const constant = new RegExp(`\\b(?:static\\s+final\\s+String|final\\s+static\\s+String|const\\s+val)\\s+${ref[2]}\\s*(?::\\s*String\\s*)?=\\s*"([^"]+)"`).exec(sourceText);
      if (constant) return constant[1]!;
    }
  }
  return null;
}

/**
 * A DAO row names the entity its receiver implies (`fanRepository.save` → `Fan`); a
 * Spring Data repository states the one it works on (`interface RepositoryFan extends
 * JpaRepository<EntityClubFan, Long>`). A row whose implied name is no entity takes the
 * entity stated by the repository type of the file's member implying that name, when
 * every such member agrees. An entity declared in a dependency is the first type argument.
 */
function statedRepositoryEntities(jvm: readonly FileAnalysis[]): void {
  const entities = new Set(jvm.flatMap((a) => (a.classes ?? []).filter((c) => c.decorators?.includes("entity")).map((c) => c.name)));
  const stated = new Map<string, string>();
  for (const a of jvm) {
    for (const cls of a.classes ?? []) {
      if (cls.kind !== "interface") continue;
      const bases = [cls.extends ?? "", ...(cls.implements ?? [])];
      const entity = bases
        .flatMap((base) => typeArguments(base))
        .map((arg) => arg.replace(/^.*\./, ""))
        .find((arg) => entities.has(arg))
        // An entity the project does not declare (it comes from a dependency): the first type argument
        // of a Spring Data base (`Repository<DocumentMeta, String>`), when it names a class.
        ?? bases.filter((base) => /^(?:[\w.]*\.)?\w*Repository\s*</.test(base))
          .map((base) => typeArguments(base)[0]?.replace(/^.*\./, ""))
          .find((arg): arg is string => !!arg && /^[A-Z]\w*$/.test(arg) && !REPOSITORY_ID_TYPES.has(arg));
      if (entity) stated.set(cls.name, entity);
    }
  }
  if (stated.size === 0) return;
  for (const a of jvm) {
    const rows = (a.dataSources ?? []).filter((ds) => ds.kind === "database" && ds.name.startsWith("DAO: ") && ds.entity && !entities.has(ds.entity));
    if (rows.length === 0) continue;
    // What each repository-typed member implies, as the row's extractor read it.
    const implied = new Map<string, Set<string>>();
    for (const cls of a.classes ?? []) {
      const members = [...cls.properties, ...cls.methods.flatMap((m) => m.params)];
      for (const m of members) {
        const type = m.type?.replace(/<.*$/, "").replace(/^.*\./, "");
        const entity = type ? stated.get(type) : undefined;
        const name = entity ? daoReceiverEntity(m.name, new Map([[m.name, type!]])) : null;
        if (name) (implied.get(name) ?? implied.set(name, new Set()).get(name)!).add(entity!);
      }
    }
    for (const ds of rows) {
      const options = implied.get(ds.entity!);
      if (options?.size !== 1) continue;
      const [entity] = options;
      if (ds.target === ds.entity) ds.target = entity!;
      ds.entity = entity!;
    }
  }
}

/**
 * A DAO whose implementation states its table in SQL (`RawMessageDAOImpl` running
 * `INSERT INTO hnfwk_local_event_queue …`): a call through the DAO type
 * (`rawMessageDAO.create(…)`, read as `RawMessage` from the DAO's name) touches
 * that table, not a value class the DAO's name happens to spell. Only when the
 * implementations' own SQL names exactly one table, and the name read is no
 * declared entity.
 */
function implementedDaoTables(jvm: readonly FileAnalysis[]): void {
  const entities = new Set(jvm.flatMap((a) => (a.classes ?? []).filter((c) => c.decorators?.includes("entity")).map((c) => c.name)));
  const tablesOf = new Map<string, Set<string>>();
  for (const a of jvm) {
    for (const cls of a.classes ?? []) {
      if (cls.kind === "interface" || cls.implements.length === 0) continue;
      const tables = (a.dataSources ?? [])
        .filter((ds) => ds.kind === "database" && ds.entity && !ds.routine && !ds.name.startsWith("DAO: ") && ds.line >= cls.line && ds.line <= cls.endLine)
        .map((ds) => ds.entity!);
      if (tables.length === 0) continue;
      for (const iface of cls.implements) {
        const name = iface.replace(/<.*$/, "").replace(/^.*\./, "");
        const set = tablesOf.get(name) ?? tablesOf.set(name, new Set()).get(name)!;
        for (const t of tables) set.add(t);
      }
    }
  }
  if (tablesOf.size === 0) return;
  for (const a of jvm) {
    const rows = (a.dataSources ?? []).filter((ds) => ds.kind === "database" && ds.name.startsWith("DAO: ") && ds.entity && !entities.has(ds.entity));
    if (rows.length === 0) continue;
    // The DAO types each name the row's extractor read stands for.
    const typed = new Map<string, Set<string>>();
    for (const cls of a.classes ?? []) {
      for (const m of [...cls.properties, ...cls.methods.flatMap((x) => x.params)]) {
        const type = m.type?.replace(/<.*$/, "").replace(/^.*\./, "");
        if (!type || !tablesOf.has(type)) continue;
        const name = daoReceiverEntity(m.name, new Map([[m.name, type]]));
        if (name) (typed.get(name) ?? typed.set(name, new Set()).get(name)!).add(type);
      }
    }
    for (const ds of rows) {
      const types = typed.get(ds.entity!);
      const tables = types?.size === 1 ? tablesOf.get([...types][0]!) : undefined;
      if (tables?.size !== 1) continue;
      const [table] = tables;
      if (ds.target === ds.entity) ds.target = table!;
      ds.entity = table!;
    }
  }
}

/**
 * A `DAO: findArea` row on a receiver whose declared type is a class of the
 * project (`GeographicAreaCopyRepository repository; repository.findArea(id)`,
 * `documentRepository.getSession()`) names an entity after the receiver, not
 * after what the method does: the method's own body is in the analysis, with
 * whatever access it makes (`em.createQuery("… from GeoArea a")`), which the
 * call graph reaches. Such a row whose name is no entity is dropped.
 */
function projectDaoMethodCalls(jvm: readonly FileAnalysis[]): void {
  const entities = new Set(jvm.flatMap((a) => (a.classes ?? []).filter((c) => c.decorators?.includes("entity")).map((c) => c.name)));
  // The methods each concrete project class declares.
  const declaring = new Map<string, Set<string>>();
  for (const a of jvm) {
    for (const cls of a.classes ?? []) {
      if (cls.kind === "interface" || cls.methods.length === 0) continue;
      const set = declaring.get(cls.name) ?? declaring.set(cls.name, new Set()).get(cls.name)!;
      for (const m of cls.methods) set.add(m.name);
    }
  }
  if (declaring.size === 0) return;
  for (const a of jvm) {
    if (!(a.dataSources ?? []).some((ds) => ds.name.startsWith("DAO: ") && ds.entity && !entities.has(ds.entity))) continue;
    const typed = new Map<string, Set<string>>();
    for (const cls of a.classes ?? []) {
      for (const m of [...cls.properties, ...cls.methods.flatMap((x) => x.params)]) {
        const type = m.type?.replace(/<.*$/, "").replace(/^.*\./, "");
        if (!type || !declaring.has(type)) continue;
        const name = daoReceiverEntity(m.name, new Map([[m.name, type]]));
        if (name) (typed.get(name) ?? typed.set(name, new Set()).get(name)!).add(type);
      }
    }
    if (typed.size === 0) continue;
    a.dataSources = (a.dataSources ?? []).filter((ds) => {
      if (!ds.name.startsWith("DAO: ") || !ds.entity || entities.has(ds.entity)) return true;
      const types = typed.get(ds.entity);
      return !(types?.size === 1 && declaring.get([...types][0]!)!.has(ds.name.slice(5)));
    });
  }
}

/** Id and value types, and the usual type variables: never the entity a repository's first type argument names. */
const REPOSITORY_ID_TYPES = new Set(["Long", "Integer", "String", "UUID", "Object", "Short", "Byte", "Double", "Float", "Boolean", "Int", "T", "E", "ID", "K", "V"]);

/** `JpaRepository<EntityFan, Long>` → `["EntityFan", "Long"]`: the top-level type arguments. */
function typeArguments(type: string): string[] {
  const open = type.indexOf("<");
  if (open < 0 || !type.trimEnd().endsWith(">")) return [];
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of type.slice(open + 1, type.trimEnd().length - 1)) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((t) => t.replace(/<.*$/, ""));
}

/**
 * A call handing a declared query's name to a project helper (`list("match.by.club")`,
 * which runs `createNamedQuery(name)` a frame or two down) runs that query
 * there: a read of its entity at the call, unless a row there already names it.
 */
function addHelperQueryRuns(a: FileAnalysis, byName: ReadonlyMap<string, NamedQueryRun | null>): void {
  const calls = [...a.functions, ...a.classes.flatMap((c) => c.methods)].flatMap((fn) => fn.calls.filter((c) => c.args));
  for (const call of calls) {
    const name = call.args!.map((x) => /^"([^"]+)"$/.exec(x)?.[1]).find((n) => n !== undefined && byName.get(n));
    const query = name ? byName.get(name) : null;
    if (!query) continue;
    a.dataSources ??= [];
    if (a.dataSources.some((d) => d.line === call.line && d.entity === query.entity)) continue;
    a.dataSources.push({ kind: "database", name: call.name, target: query.entity, entity: query.entity, namedQuery: name, access: query.access, calls: [], line: call.line });
  }
}

/**
 * A generic DAO method (`<T extends Tenanted> T create(T entity) { … em.merge(entity) … }`)
 * writes whatever it is handed, so its own rows name no entity. Each call of it that hands
 * one variable (`change.create(address)`, `Address address`) writes that variable's declared
 * type: a row at the call. A generic method is one with a type-variable parameter and untyped
 * `database` rows in its body; the call is matched by its receiver's declared class.
 */
function handedEntityAccess(jvm: readonly FileAnalysis[]): void {
  const simple = (t: string | null | undefined): string | null => t?.replace(/<.*$/, "").replace(/^.*\./, "").trim() || null;
  const typeVariable = (t: string | null | undefined): boolean => /^[A-Z][A-Z0-9]?$/.test(t?.trim() ?? "");
  const generic = new Map<string, Map<string, "read" | "write">>();
  for (const a of jvm) {
    for (const cls of a.classes ?? []) {
      for (const m of cls.methods) {
        if (!m.params.some((p) => typeVariable(p.type))) continue;
        const rows = (a.dataSources ?? []).filter((d) => d.kind === "database" && !d.entity && d.line >= m.line && d.line <= (m.endLine ?? m.line));
        if (rows.length === 0) continue;
        const access = rows.some((r) => r.access === "write") || rows.every((r) => !r.access) ? "write" : "read";
        (generic.get(cls.name) ?? generic.set(cls.name, new Map()).get(cls.name)!).set(m.name, access);
      }
    }
  }
  if (generic.size === 0) return;
  for (const a of jvm) {
    for (const cls of a.classes ?? []) {
      const members = new Map<string, string>();
      for (const p of cls.properties) if (p.type) members.set(p.name, p.type);
      for (const m of cls.methods) {
        const scope = new Map(members);
        for (const p of m.params) if (p.type) scope.set(p.name, p.type);
        for (const l of m.localTypes ?? []) if (l.type) scope.set(l.name, l.type);
        for (const call of m.calls) {
          if (call.args?.length !== 1) continue;
          const parts = /^(?:this\.)?([\w$]+)\.([\w$]+)$/.exec(call.name);
          const owner = parts ? simple(call.receiverType ?? scope.get(parts[1]!)) : null;
          const access = owner ? generic.get(owner)?.get(parts![2]!) : undefined;
          const entity = access ? simple(scope.get(call.args[0]!)) : null;
          if (!access || !entity || typeVariable(entity) || /^(?:Object|String|Long|Integer)$/.test(entity)) continue;
          a.dataSources ??= [];
          if (a.dataSources.some((d) => d.line === call.line && d.entity === entity)) continue;
          a.dataSources.push({ kind: "database", name: `${owner}.${parts![2]}`, target: entity, entity, access, calls: [], line: call.line });
        }
      }
    }
  }
}

/**
 * A helper publishing what it is handed (`protected void emitSubEntity(T entity, Object event)
 * { eventPublisher.send(audit, meta, event); }`, its row marked `payloadParameter`)
 * publishes, at each call in its class or a subclass, the event type the call hands
 * it there (`AddressCreatedEvent event = …; emitSubEntity(address, event)`): a row
 * at the call. The marker rows themselves name nothing and are dropped.
 */
function helperPublishedEvents(jvm: readonly FileAnalysis[]): void {
  const simple = (t: string | null | undefined): string | null => t?.replace(/<.*$/, "").replace(/^.*\./, "").trim() || null;
  const helpers = new Map<string, Map<string, { index: number; name: string }>>();
  for (const a of jvm) {
    const marked = (a.dataSources ?? []).filter((d) => d.kind === "queue-publish" && d.payloadParameter !== undefined);
    if (marked.length === 0) continue;
    for (const ds of marked) {
      const cls = a.classes.find((c) => ds.line >= c.line && ds.line <= c.endLine && c.methods.some((m) => ds.line >= m.line && ds.line <= (m.endLine ?? m.line)));
      const m = cls?.methods.find((x) => ds.line >= x.line && ds.line <= (x.endLine ?? x.line));
      if (cls && m) (helpers.get(cls.name) ?? helpers.set(cls.name, new Map()).get(cls.name)!).set(m.name, { index: ds.payloadParameter!, name: ds.name });
    }
    a.dataSources = a.dataSources.filter((d) => d.payloadParameter === undefined);
  }
  if (helpers.size === 0) return;
  const baseOf = new Map<string, string>();
  for (const a of jvm) for (const cls of a.classes) { const b = simple(cls.extends); if (b) baseOf.set(cls.name, b); }
  for (const a of jvm) {
    for (const cls of a.classes) {
      const chain: string[] = [];
      for (let c: string | undefined = cls.name; c && chain.length < 6 && !chain.includes(c); c = baseOf.get(c)) chain.push(c);
      if (!chain.some((c) => helpers.has(c))) continue;
      const fields = new Map(cls.properties.filter((p) => p.type).map((p) => [p.name, p.type!]));
      for (const m of cls.methods) {
        const scope = new Map(fields);
        for (const p of m.params) if (p.type) scope.set(p.name, p.type);
        for (const l of m.localTypes ?? []) if (l.type) scope.set(l.name, l.type);
        for (const call of m.calls) {
          const name = /^(?:this\.|super\.)?([\w$]+)$/.exec(call.name)?.[1];
          const helper = name ? chain.map((c) => helpers.get(c)?.get(name)).find(Boolean) : undefined;
          const arg = helper ? call.args?.[helper.index]?.trim() : undefined;
          if (!helper || !arg) continue;
          // `new X(…)`, a protobuf `X.newBuilder()…` / `X.getDefaultInstance()`, or a typed name.
          const type = simple(/^new\s+([\w.]+)/.exec(arg)?.[1]
            ?? /^([A-Z][\w.]*?)\s*\.\s*(?:newBuilder|getDefaultInstance)\s*\(/.exec(arg)?.[1]
            ?? (/^[\w$]+$/.test(arg) ? scope.get(arg) : null));
          if (!type || !EVENT_TYPE_RE.test(type) || GENERIC_EVENT_TYPE_RE.test(type)) continue;
          a.dataSources ??= [];
          if (a.dataSources.some((d) => d.line === call.line && d.kind === "queue-publish" && d.target === type)) continue;
          a.dataSources.push({ kind: "queue-publish", name: helper.name, target: type, calls: [], line: call.line });
        }
      }
    }
  }
}

/** What running a named query does: the entity it reads or writes. */
interface NamedQueryRun {
  entity: string;
  access: "read" | "write";
}

/** Every declared named query by name; null for a name two declarations disagree on. */
function namedQueryEntities(analyses: FileAnalysis[]): Map<string, NamedQueryRun | null> {
  const onClasses = analyses.flatMap((a) => a.classes.flatMap((cls) => cls.decorators.flatMap((d) => namedQueryDeclarations(d, cls.name))));
  // A mapping file's queries are functions decorated alike, their declaring entity `@entity("X")`.
  const inMappings = analyses.filter((a) => a.language === "springxml").flatMap((a) => a.functions.flatMap((fn) => {
    const owner = fn.decorators.map((d) => /^@entity\("(\w+)"\)$/.exec(d)?.[1]).find(Boolean) ?? fn.name;
    return fn.decorators.flatMap((d) => namedQueryDeclarations(d, owner));
  }));
  const declared = [...onClasses, ...inMappings];
  const byName = new Map<string, NamedQueryRun | null>();
  for (const q of declared) {
    const prev = byName.get(q.name);
    const same = prev === undefined || (prev !== null && prev.entity === q.entity && prev.access === q.access);
    byName.set(q.name, same ? { entity: q.entity, access: q.access } : null);
  }
  return byName;
}

/**
 * The queries a `@NamedQuery` / `@NamedQueries({…})` / `@NamedNativeQuery`
 * decorator declares: each name with the entity it reads — the JPQL's `from`
 * entity, a native query's `resultClass`, else the declaring class.
 */
export function namedQueryDeclarations(decorator: string, declaringClass: string): Array<{ name: string; entity: string } & NamedQueryRun> {
  const out: Array<{ name: string } & NamedQueryRun> = [];
  const parts = decorator.split(/@?(?=\bNamed(?:Native)?Query\s*\()/).filter((p) => /^Named(?:Native)?Query\s*\(/.test(p));
  for (const part of parts) {
    const name = /\bname\s*=\s*"([^"]+)"/.exec(part)?.[1];
    // An update or delete query writes; anything else reads.
    const access = /\bquery\s*=\s*"\s*(?:update|delete|insert)\b/i.test(part) ? "write" : "read";
    if (name) out.push({ name, entity: namedQueryEntity(part) ?? declaringClass, access });
  }
  return out;
}

/** What one declaration reads: a JPQL query's `from` entity, else a native query's `resultClass`. */
function namedQueryEntity(declaration: string): string | undefined {
  const resultClass = /\bresultClass\s*=\s*([A-Z]\w*)\.class/.exec(declaration)?.[1];
  if (declaration.startsWith("NamedNativeQuery")) return resultClass;
  const query = /\bquery\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)/.exec(declaration)?.[1] ?? "";
  return /\b(?:from|FROM|From)\s+([A-Z]\w*)\b/.exec(query.replace(/"\s*\+\s*"/g, ""))?.[1] ?? resultClass;
}
