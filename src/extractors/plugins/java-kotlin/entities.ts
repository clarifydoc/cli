import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";

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
                // PropertyInfo has no dedicated db-column field, so the property
                // keeps the Java/Kotlin field name (what downstream consumers
                // match on) and carries the declared type. An explicit
                // `@Column("col")` / `@Column(name="col")` physical-column
                // mapping cannot be represented in PropertyInfo today and is
                // intentionally not folded into the name/type (see notes).
                properties.push(this.column(field.name, field.type));
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
