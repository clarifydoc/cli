import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Decorator name → cardinality map for TypeORM / MikroORM relation decorators.
 * MikroORM's `@Collection` is treated as a one-to-many (it is the inverse,
 * collection side of a relation).
 */
const DECORATOR_CARDINALITY: Record<string, EntityRelation["cardinality"]> = {
  OneToMany: "one-to-many",
  ManyToOne: "many-to-one",
  OneToOne: "one-to-one",
  ManyToMany: "many-to-many",
  Collection: "one-to-many",
  // sequelize-typescript associations.
  BelongsTo: "many-to-one",
  HasMany: "one-to-many",
  HasOne: "one-to-one",
  BelongsToMany: "many-to-many",
  // A schema DSL's foreign-key column (`@ForeignKeyColumn(() => ClubTable, { onDelete })`): the field is the key.
  ForeignKeyColumn: "many-to-one",
};

/** Relation decorators whose field is the foreign key column itself. */
const KEY_COLUMN_RELATIONS = new Set(["ForeignKeyColumn"]);

/** Sequelize association method → cardinality map. */
const SEQUELIZE_CARDINALITY: Record<string, EntityRelation["cardinality"]> = {
  hasMany: "one-to-many",
  belongsTo: "many-to-one",
  hasOne: "one-to-one",
  belongsToMany: "many-to-many",
};

/** TypeORM/MikroORM column decorators that mark a persisted scalar/value field. */
const COLUMN_DECORATORS =
  /^@(Column|PrimaryGeneratedColumn|PrimaryColumn|ObjectIdColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|Property|Enum|Embedded|RelationId|PrimaryKey|ForeignKey)\b/;

/** Line-comment prefixes for the C-family languages this extractor handles. */
const SLASH_COMMENT = ["//"] as const;

/**
 * Extracts ORM entities + relations from TypeScript/JavaScript source for
 * TypeORM, MikroORM, Sequelize and Mongoose.
 *
 * Parsing is *logical-statement* based (via the shared base helpers
 * `decoratedMembers` / `logicalLines`) rather than physical-line based, so
 * multiline decorators, multiline schema fields and multiline association
 * calls are all handled as single units. Risky parsing is wrapped in
 * try/catch — the extractor never throws and returns whatever it could parse.
 */
export class JavaScriptEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    try {
      this.extractDecoratorEntities(ctx, entities, relations);
    } catch {
      /* keep what we have */
    }
    try {
      this.extractSequelize(ctx, entities, relations);
    } catch {
      /* keep what we have */
    }
    try {
      this.extractMongoose(ctx, entities, relations);
    } catch {
      /* keep what we have */
    }
    try {
      if (/\b(?:pg|mysql|sqlite|singlestore)Table\s*\(/.test(ctx.sourceText)) this.extractDrizzle(ctx, entities, relations);
    } catch {
      /* keep what we have */
    }

    return { entities, relations };
  }

  // ─── TypeORM / MikroORM ──────────────────────────────────────────────────

  private extractDecoratorEntities(
    ctx: EntityExtractContext,
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    const orm = this.decoratorOrm(ctx);
    const knownClasses = new Set(ctx.analysis.classes.map((c) => c.name));

    for (const cls of ctx.analysis.classes) {
      if (!this.isEntityClass(ctx, cls)) continue;

      // Use the brace INTERIOR — `bodyOf` includes the `class X {` opener whose
      // `{` would make `logicalLines` collapse the whole class into one
      // unbalanced statement, killing all decorator extraction.
      const body = this.bodyInteriorOf(ctx, cls);
      const properties: PropertyInfo[] = [];
      const targets = new Set<string>();

      // Group stacked / inline / multiline decorators with their member.
      let members: Array<{ decorators: string[]; declaration: string; line: number }> = [];
      try {
        members = this.decoratedMembers(body, { style: "at", lineComment: SLASH_COMMENT });
      } catch {
        members = [];
      }

      for (const member of members) {
        try {
          this.processDecoratedMember(member, cls, orm, knownClasses, properties, relations, targets);
        } catch {
          // Skip unparseable members — never abort the whole class.
        }
      }

      entities.push(
        this.entity({
          name: cls.name,
          orm,
          properties,
          implementsList: [...targets],
          extends: cls.extends ?? null,
          line: cls.line,
          endLine: cls.endLine,
          // TypeORM `@Entity("app_users")`, `@Entity({ name: "app_users" })`; MikroORM `{ tableName }`;
          // sequelize-typescript / a schema DSL `@Table({ tableName | name })`.
          tableName: cls.decorators.map((d) => /^@?(?:Entity|Table)\s*\(\s*(?:["'`]([^"'`]+)["'`]|\{[^}]*?\b(?:name|tableName)\s*:\s*["'`]([^"'`]+)["'`])/.exec(d)).map((m) => m?.[1] ?? m?.[2]).find(Boolean) ?? null,
        }),
      );
    }
  }

  /**
   * Process one decorated member: detect relation decorators (emitting an
   * `EntityRelation`) or column decorators (emitting a scalar `PropertyInfo`).
   * Only genuine ORM associations become relations — scalar/value columns do
   * not, which keeps relation false-positives low.
   */
  private processDecoratedMember(
    member: { decorators: string[]; declaration: string; line: number },
    cls: ClassInfo,
    orm: string,
    knownClasses: Set<string>,
    properties: PropertyInfo[],
    relations: EntityRelation[],
    targets: Set<string>,
  ): void {
    const { decorators, declaration } = member;
    if (decorators.length === 0) return;

    // Find a relation decorator among the stacked decorators (e.g. @OneToMany).
    const relDecorator = decorators.find((d) => {
      const name = this.decoratorName(d);
      return name != null && name in DECORATOR_CARDINALITY;
    });

    if (relDecorator) {
      const relName = this.decoratorName(relDecorator)!;
      const cardinality = DECORATOR_CARDINALITY[relName];
      const target = this.relationTarget(relDecorator);
      const decl = this.parseFieldDeclaration(declaration);

      if (target || (decl && this.looksLikeEntityType(decl.type, knownClasses))) {
        // Prefer the explicit decorator target; fall back to the field's core type.
        const toEntity = target ?? this.coreType(decl?.type);
        if (toEntity) {
          const inverseField = this.inverseField(relDecorator);
          // @JoinColumn → owning-side FK; @JoinTable → M2M join table name.
          const foreignKey = KEY_COLUMN_RELATIONS.has(relName) ? decl?.name ?? null : this.joinColumnName(decorators);
          const joinTable = this.joinTableName(decorators);
          const optional = decl ? this.isOptional(decl) : false;
          // EXTRACTED when the ORM names the target explicitly in the decorator;
          // INFERRED when we only derived the target from the field's TS type.
          const explicitTarget = target != null;
          relations.push({
            fromEntity: cls.name,
            fromField: decl?.name ?? this.lcFirst(toEntity),
            toEntity,
            cardinality,
            foreignKey,
            inverseField,
            joinTable,
            optional,
            orm,
            confidence: explicitTarget ? "EXTRACTED" : "INFERRED",
          });
          targets.add(toEntity);
        }
      }
      // A foreign-key column is a column too.
      if (KEY_COLUMN_RELATIONS.has(relName) && decl) properties.push(this.column(decl.name, this.coreType(decl.type) ?? decl.type));
      return;
    }

    // Column decorators → scalar/value property (not a relation).
    if (decorators.some((d) => COLUMN_DECORATORS.test(d.trim()))) {
      const decl = this.parseFieldDeclaration(declaration);
      if (decl) {
        // Prefer the DB-level column type declared in the decorator
        // (e.g. @Column({ type: 'varchar', length: 100 })), else the TS type.
        const dbType = this.columnDbType(decorators);
        properties.push(this.column(decl.name, dbType ?? this.coreType(decl.type) ?? decl.type));
      }
    }
  }

  /** Extract the bare decorator name from a raw decorator string (`@Name(...)` → `Name`). */
  private decoratorName(raw: string): string | null {
    const m = raw.trim().match(/^@\s*([A-Za-z_$][\w$]*)/);
    return m ? m[1] : null;
  }

  /**
   * Capture the relation target entity from a relation decorator, supporting
   * all three TypeORM/MikroORM target syntaxes:
   *   - empty-param arrow:  `() => Target`
   *   - single-param arrow: `(x) => Target`
   *   - quoted string:      `'Target'` / `"Target"`
   * Returns the bare entity name (array/generic suffixes stripped) or null.
   */
  private relationTarget(decorator: string): string | null {
    const args = this.decoratorArgs(decorator);
    if (args == null) return null;
    const firstArg = this.splitTopLevelArgs(args)[0];
    if (!firstArg) return null;
    const trimmed = firstArg.trim();

    // Arrow target: `() => Target`, `(x) => Target`, `type => Target`.
    const arrow = trimmed.match(/=>\s*([A-Za-z_$][\w$.]*(?:\s*\[\s*\])?)/);
    if (arrow) return this.coreType(arrow[1]);

    // Quoted-string target: 'Target' / "Target" / `Target`.
    const quoted = trimmed.match(/^["'`]([A-Za-z_$][\w$.]*)["'`]$/);
    if (quoted) return this.coreType(quoted[1]);

    return null;
  }

  /**
   * Capture the inverse-side field name from the second lambda of a relation
   * decorator, e.g. `(post) => post.author` yields `author`. Returns null when
   * the decorator has no inverse-side lambda.
   */
  private inverseField(decorator: string): string | null {
    const args = this.decoratorArgs(decorator);
    if (args == null) return null;
    const parts = this.splitTopLevelArgs(args);
    // The inverse lambda is the 2nd argument when present.
    const second = parts[1]?.trim();
    if (!second) return null;
    // `(post) => post.author` or `post => post.author` → `author`.
    const m = second.match(/=>\s*[A-Za-z_$][\w$]*\s*\.\s*([A-Za-z_$][\w$]*)/);
    return m ? m[1] : null;
  }

  /**
   * Find a `@JoinColumn({ name: "x" })` among the stacked decorators and return
   * its column name (owning-side foreign key). Bracket-aware so nested objects
   * do not break matching.
   */
  private joinColumnName(decorators: string[]): string | null {
    for (const d of decorators) {
      if (!/^@\s*JoinColumn\b/.test(d.trim())) continue;
      const name = this.optionName(this.decoratorArgs(d));
      if (name) return name;
    }
    return null;
  }

  /**
   * Find a `@JoinTable({ name: "post_tags", ... })` among the stacked decorators
   * and return the join-table name for a many-to-many relation.
   */
  private joinTableName(decorators: string[]): string | null {
    for (const d of decorators) {
      if (!/^@\s*JoinTable\b/.test(d.trim())) continue;
      const name = this.optionName(this.decoratorArgs(d));
      if (name) return name;
    }
    return null;
  }

  /**
   * Extract the DB column type from a `@Column` / `@Property` decorator, e.g.
   * `@Column('varchar')` → `varchar`, `@Column({ type: 'varchar', length: 100 })`
   * → `varchar(100)`. Returns null when no DB type is declared.
   */
  private columnDbType(decorators: string[]): string | null {
    const colDec = decorators.find((d) => /^@\s*(Column|Property)\b/.test(d.trim()));
    if (!colDec) return null;
    const args = this.decoratorArgs(colDec);
    if (args == null) return null;
    const parts = this.splitTopLevelArgs(args);
    if (parts.length === 0) return null;

    const first = parts[0].trim();
    // Positional string type: @Column('varchar').
    const positional = first.match(/^["'`]([A-Za-z0-9_]+)["'`]$/);
    if (positional) return positional[1];

    // Option object: { type: 'varchar', length: 100 }.
    const typeMatch = first.match(/\btype\s*:\s*["'`]([A-Za-z0-9_]+)["'`]/);
    if (typeMatch) {
      const lengthMatch = first.match(/\blength\s*:\s*(\d+)/);
      return lengthMatch ? `${typeMatch[1]}(${lengthMatch[1]})` : typeMatch[1];
    }
    return null;
  }

  /** Pull a `name: "..."` option out of a decorator argument string. */
  private optionName(args: string | null): string | null {
    if (args == null) return null;
    const m = args.match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/);
    return m ? m[1] : null;
  }

  /**
   * Return the *balanced* argument text inside a decorator's parentheses, e.g.
   * `@OneToMany(() => Post, p => p.author)` → `() => Post, p => p.author`.
   * Bracket-aware (handles nested parens / objects / strings); null if the
   * decorator carries no call parentheses.
   */
  private decoratorArgs(decorator: string): string | null {
    const open = decorator.indexOf("(");
    if (open < 0) return null;
    const close = this.matchBracket(decorator, open);
    if (close < 0) return null;
    return decorator.slice(open + 1, close);
  }

  /**
   * Split a decorator/argument list on top-level commas, respecting nested
   * brackets and string literals so `() => Post, { cascade: true }` splits into
   * two parts rather than tripping on the comma inside the object.
   */
  private splitTopLevelArgs(args: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote = "";
    let buf = "";
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (quote) {
        buf += ch;
        if (ch === "\\") {
          if (i + 1 < args.length) {
            buf += args[i + 1];
            i++;
          }
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      if (ch === "," && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) parts.push(buf);
    return parts;
  }

  /**
   * Parse a member declaration produced by `decoratedMembers`, e.g.
   * `posts!: Post[];` or `email: string = ''`. Returns the field name and its
   * declared TypeScript type, or null for non-field declarations (methods, etc.).
   */
  private parseFieldDeclaration(
    declaration: string,
  ): { name: string; type: string | null; marker: string; raw: string } | null {
    const decl = declaration.trim();
    if (!decl) return null;
    const m = decl.match(
      /^(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|declare\s+)*([A-Za-z_$][\w$]*)\s*([!?]?)\s*:\s*([^;=]+?)\s*(?:[;=]|$)/,
    );
    if (!m) {
      // Field without a type annotation: `name = DataTypes...` style — keep name only.
      const bare = decl.match(/^([A-Za-z_$][\w$]*)\s*([!?]?)\s*[=;]/);
      if (bare) return { name: bare[1], type: null, marker: bare[2], raw: decl };
      return null;
    }
    // Reject method-looking declarations (a `(` before the colon means a method).
    if (/^[A-Za-z_$][\w$]*\s*\(/.test(decl)) return null;
    return { name: m[1], type: this.cleanType(m[3]), marker: m[2], raw: decl };
  }

  /**
   * Decide whether a relation is optional. Handles all three TS nullability
   * signals: the `?` optional marker, a `| null` / `| undefined` union, and
   * leaves the `!` definite-assignment marker as non-optional.
   */
  private isOptional(decl: { type: string | null; marker: string }): boolean {
    if (decl.marker === "?") return true;
    if (decl.type && /\|\s*(null|undefined)\b/i.test(decl.type)) return true;
    return false;
  }

  /** A type that resolves to a known class (or PascalCase identifier) is entity-shaped. */
  private looksLikeEntityType(type: string | null, knownClasses: Set<string>): boolean {
    const core = this.coreType(type);
    if (!core) return false;
    if (knownClasses.has(core)) return true;
    // Heuristic: PascalCase, non-primitive identifier.
    return /^[A-Z][A-Za-z0-9_$]*$/.test(core) && !this.isPrimitiveType(core);
  }

  private isPrimitiveType(t: string): boolean {
    return /^(String|Number|Boolean|Date|Object|Array|Buffer|Symbol|BigInt|Function|Map|Set|Promise|Any|Unknown|Void|Null|Undefined)$/.test(
      t,
    );
  }

  /** Choose the decorator-ORM flavour from this file's imports. */
  private decoratorOrm(ctx: EntityExtractContext): string {
    const sources = ctx.analysis.imports.map((imp) => imp.source);
    // Match `@mikro-orm/core`, `@mikro-orm/postgresql`, etc. broadly.
    if (sources.some((s) => s.includes("mikro-orm"))) return "mikro-orm";
    if (sources.some((s) => s.includes("typeorm"))) return "typeorm";
    if (sources.some((s) => s.includes("sequelize-typescript"))) return "sequelize";
    // A schema DSL of its own (a `@league/sql-tools`-style package): the package that supplies `@Table`.
    const tablePkg = ctx.analysis.imports.find((imp) => imp.specifiers.includes("Table") && !imp.source.startsWith("."))?.source;
    if (tablePkg) return tablePkg.replace(/^@/, "").split("/").pop()!;
    return "typeorm";
  }

  /**
   * A class is an entity when it is decorated (directly or via a preceding
   * decorator line) with `@Entity` / `@Embeddable`. Uses logical-statement
   * scanning of the lines preceding the class declaration so multiline
   * `@Entity({ ... })` options are recognized. Tightened to require a genuine
   * entity marker — a class merely *named* something is never an entity.
   */
  private isEntityClass(ctx: EntityExtractContext, cls: ClassInfo): boolean {
    if (cls.decorators.some((d) => /^(entity|embeddable)$/i.test(d.replace(/\(.*$/s, "").trim()))) {
      return true;
    }
    // `@Table({ … })` (sequelize-typescript, a schema DSL) over a class whose members are columns.
    if (cls.decorators.some((d) => /^@?Table\b/.test(d.trim())) && this.bodyInteriorOf(ctx, cls).some((l) => /@(?:Column|PrimaryGeneratedColumn|PrimaryKey|PrimaryColumn)\b/.test(l))) return true;
    // Some pipelines store decorators with the leading '@' or call args intact.
    if (cls.decorators.some((d) => /@?\s*(Entity|Embeddable)\b/.test(d))) return true;

    const declIdx = this.findClassDecl(ctx, cls);
    if (declIdx < 0) return false;

    // Look back over the decorator block immediately above the class. Stop as
    // soon as we hit a non-decorator, non-blank line (the previous statement).
    for (let i = declIdx - 1; i >= 0 && i >= declIdx - 12; i--) {
      const raw = this.stripLineComment(ctx.lines[i] ?? "", SLASH_COMMENT).trim();
      if (raw === "") continue;
      if (/@\s*(Entity|Embeddable)\b/.test(raw)) return true;
      // A decorator line (possibly the tail of a multiline decorator) — keep going.
      if (raw.startsWith("@") || /^[A-Za-z_$][\w$]*\s*[:,)]/.test(raw) || /^[)\]}]/.test(raw)) {
        continue;
      }
      break;
    }
    return false;
  }

  /** Locate the 0-based line index of the `class <name>` declaration. */
  private findClassDecl(ctx: EntityExtractContext, cls: ClassInfo): number {
    const classRe = new RegExp(`\\bclass\\s+${this.escape(cls.name)}\\b`);
    const searchStart = Math.max(0, cls.line - 1);
    for (let i = searchStart; i < ctx.lines.length && i < searchStart + 3; i++) {
      if (classRe.test(ctx.lines[i])) return i;
    }
    for (let i = 0; i < ctx.lines.length; i++) {
      if (classRe.test(ctx.lines[i])) return i;
    }
    return -1;
  }

  // ─── Sequelize ────────────────────────────────────────────────────────────

  private extractSequelize(
    ctx: EntityExtractContext,
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    const isSequelize = ctx.analysis.imports.some((imp) => imp.source.includes("sequelize"));
    // Logical statements collapse multiline define/init/association calls.
    const logical = this.logicalLines(ctx.lines, { lineComment: SLASH_COMMENT });
    const known = new Set(entities.map((e) => e.name));

    for (const stmt of logical) {
      try {
        this.processSequelizeStatement(stmt, ctx, isSequelize, entities, relations, known);
      } catch {
        // Skip unparseable statements.
      }
    }
  }

  private processSequelizeStatement(
    stmt: { text: string; line: number },
    ctx: EntityExtractContext,
    isSequelize: boolean,
    entities: ClassInfo[],
    relations: EntityRelation[],
    known: Set<string>,
  ): void {
    const text = stmt.text;

    // a) sequelize.define("User", { ... })
    const defineMatch = text.match(/\.define\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/);
    if (defineMatch && (isSequelize || /DataTypes/.test(text))) {
      const name = defineMatch[1];
      const openIdx = text.indexOf("{", defineMatch.index ?? 0);
      const props = this.parseFieldColumns(text, openIdx);
      if (!known.has(name)) {
        entities.push(
          this.entity({ name, orm: "sequelize", properties: props, line: stmt.line + 1, tableName: sequelizeTableName(text) }),
        );
        known.add(name);
      }
      return;
    }

    // b) X.init({ ... }, { ... }) — paired with `class X extends Model`.
    const initMatch = text.match(/\b([A-Za-z_$][\w$]*)\s*\.\s*init\s*\(\s*\{/);
    if (initMatch && (isSequelize || /DataTypes/.test(text))) {
      const name = initMatch[1];
      const openIdx = text.indexOf("{", initMatch.index ?? 0);
      const props = this.parseFieldColumns(text, openIdx);
      if (!known.has(name)) {
        const cls = ctx.analysis.classes.find((c) => c.name === name);
        entities.push(
          this.entity({
            name,
            orm: "sequelize",
            properties: props,
            extends: cls?.extends ?? null,
            line: cls?.line ?? stmt.line + 1,
            endLine: cls?.endLine,
            tableName: sequelizeTableName(text),
          }),
        );
        known.add(name);
      }
      return;
    }

    // c) Associations: X.hasMany(Y, { as, through, foreignKey })
    const assocMatch = text.match(
      /\b([A-Za-z_$][\w$]*)\s*\.\s*(hasMany|belongsTo|hasOne|belongsToMany)\s*\(\s*([A-Za-z_$][\w$]*)/,
    );
    if (assocMatch) {
      const fromEntity = assocMatch[1];
      const method = assocMatch[2];
      const toEntity = assocMatch[3];
      const opts = this.callOptions(text, assocMatch.index ?? 0);
      // `as` overrides the conventional field name; `through` names the M2M join
      // table; `foreignKey` is the owning-side FK.
      const alias = this.optStringValue(opts, "as");
      const through = this.optStringValue(opts, "through");
      const foreignKey = this.optStringValue(opts, "foreignKey");
      relations.push({
        fromEntity,
        fromField: alias ?? this.lcFirst(toEntity),
        toEntity,
        cardinality: SEQUELIZE_CARDINALITY[method],
        foreignKey,
        joinTable: method === "belongsToMany" ? through : null,
        orm: "sequelize",
        // EXTRACTED: the target class and (for M2M) the join table are explicit.
        confidence: "EXTRACTED",
      });
      this.ensureImplements(entities, fromEntity, toEntity);
    }
  }

  /**
   * Parse Sequelize field columns from an object literal, capturing the key and
   * its DataTypes type, e.g. `title: { type: DataTypes.STRING }` → column
   * `title: STRING`, `createdAt: DataTypes.DATE` → column `createdAt: DATE`.
   */
  private parseFieldColumns(text: string, openIdx: number): PropertyInfo[] {
    const close = this.matchBracket(text, openIdx);
    if (close < 0) return [];
    const inner = text.slice(openIdx + 1, close);
    const props: PropertyInfo[] = [];
    for (const part of this.splitTopLevelArgs(inner)) {
      const seg = part.trim();
      if (!seg) continue;
      const km = seg.match(/^["'`]?([A-Za-z_$][\w$]*)["'`]?\s*:\s*([^]*)$/);
      if (!km) continue;
      const key = km[1];
      const value = km[2].trim();
      // `DataTypes.STRING`, `Sequelize.INTEGER`, or `{ type: DataTypes.STRING }`.
      const inlineType = value.match(/(?:DataTypes|Sequelize)\s*\.\s*([A-Za-z_$][\w$]*)/);
      const type = inlineType ? inlineType[1] : null;
      props.push(this.column(key, type));
    }
    return props;
  }

  /** Extract the trailing options object of a call starting at `from`, if present. */
  private callOptions(text: string, from: number): string | null {
    const open = text.indexOf("(", from);
    if (open < 0) return null;
    const close = this.matchBracket(text, open);
    if (close < 0) return null;
    const args = text.slice(open + 1, close);
    const parts = this.splitTopLevelArgs(args);
    const last = parts[parts.length - 1]?.trim();
    if (last && last.startsWith("{")) return last;
    return null;
  }

  /** Read a quoted string option value (`as: 'articles'` → `articles`). */
  private optStringValue(opts: string | null, key: string): string | null {
    if (!opts) return null;
    const m = opts.match(new RegExp(`\\b${this.escape(key)}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
    return m ? m[1] : null;
  }

  // ─── Mongoose ───────────────────────────────────────────────────────────────

  private extractMongoose(
    ctx: EntityExtractContext,
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    const logical = this.logicalLines(ctx.lines, { lineComment: SLASH_COMMENT });

    // Map a schema variable name → parsed { fields, refs }.
    const schemas = new Map<
      string,
      {
        fields: Array<{ name: string; type: string | null }>;
        refs: Array<{ field: string; target: string; isArray: boolean }>;
        line: number;
      }
    >();

    // 1) `const userSchema = new (mongoose.)Schema({ ... })`.
    for (const stmt of logical) {
      try {
        const m = stmt.text.match(
          /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:[A-Za-z_$][\w$]*\.)?Schema\s*(?:<[^>]*>)?\s*\(\s*\{/,
        );
        if (!m) continue;
        const openIdx = stmt.text.indexOf("{", m.index ?? 0);
        const block = this.balancedBlock(stmt.text, openIdx);
        schemas.set(m[1], {
          fields: this.parseSchemaFields(block),
          refs: this.parseRefs(block),
          line: stmt.line + 1,
        });
      } catch {
        // Skip unparseable schema declarations.
      }
    }

    // 2) Model registrations:
    //    `mongoose.model("Name", schemaVar)` or
    //    `mongoose.model("Name", new Schema({ ... }))` (inline schema).
    for (const stmt of logical) {
      try {
        this.processMongooseModel(stmt, schemas, entities, relations);
      } catch {
        // Skip unparseable model registrations.
      }
    }

    // 3) Infer inverse fields for symmetric Mongoose refs (User↔Post both ways).
    this.linkInverseRelations(relations, "mongoose");
  }

  private processMongooseModel(
    stmt: { text: string; line: number },
    schemas: Map<
      string,
      {
        fields: Array<{ name: string; type: string | null }>;
        refs: Array<{ field: string; target: string; isArray: boolean }>;
        line: number;
      }
    >,
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    const m = stmt.text.match(/\bmodel\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([^]*)$/);
    if (!m) return;
    const name = m[1];
    const rest = m[2].trim();

    let fields: Array<{ name: string; type: string | null }> = [];
    let refs: Array<{ field: string; target: string; isArray: boolean }> = [];
    let line = stmt.line + 1;

    // Inline schema: `model("Name", new Schema({ ... }))`.
    const inline = rest.match(/^new\s+(?:[A-Za-z_$][\w$]*\.)?Schema\s*(?:<[^>]*>)?\s*\(\s*\{/);
    if (inline) {
      const openIdx = rest.indexOf("{");
      const block = this.balancedBlock(rest, openIdx);
      fields = this.parseSchemaFields(block);
      refs = this.parseRefs(block);
    } else {
      // Reference to a declared schema variable.
      const varMatch = rest.match(/^([A-Za-z_$][\w$]*)/);
      const schema = varMatch ? schemas.get(varMatch[1]) : undefined;
      if (schema) {
        fields = schema.fields;
        refs = schema.refs;
        line = schema.line;
      }
    }

    const targets = new Set<string>();
    for (const ref of refs) {
      relations.push({
        fromEntity: name,
        fromField: ref.field,
        toEntity: ref.target,
        cardinality: ref.isArray ? "one-to-many" : "many-to-one",
        orm: "mongoose",
        confidence: "EXTRACTED",
      });
      targets.add(ref.target);
    }

    entities.push(
      this.entity({
        name,
        orm: "mongoose",
        properties: fields.map((f) => this.column(f.name, f.type)),
        implementsList: [...targets],
        line,
      }),
    );
  }

  /**
   * Parse top-level schema fields and their scalar types from a Mongoose schema
   * object-literal block. Captures `name: String`, `name: { type: String }`,
   * and `tags: [String]`. Reference fields are handled separately by parseRefs.
   */
  private parseSchemaFields(block: string): Array<{ name: string; type: string | null }> {
    const inner = block.replace(/^\{/, "").replace(/\}$/, "");
    const fields: Array<{ name: string; type: string | null }> = [];
    for (const part of this.splitTopLevelArgs(inner)) {
      const seg = part.trim();
      if (!seg) continue;
      const km = seg.match(/^["'`]?([A-Za-z_$][\w$]*)["'`]?\s*:\s*([^]*)$/);
      if (!km) continue;
      const name = km[1];
      const value = km[2].trim();
      let type: string | null = null;
      // `{ type: String, ... }` or `{ type: [Number] }`.
      const typeOpt = value.match(/\btype\s*:\s*\[?\s*([A-Za-z_$][\w$.]*)/);
      if (typeOpt) {
        type = this.coreType(typeOpt[1]);
      } else {
        // Direct scalar: `name: String`, array: `tags: [String]`.
        const direct = value.match(/^\[?\s*([A-Za-z_$][\w$.]*)/);
        if (direct) type = this.coreType(direct[1]);
      }
      fields.push({ name, type });
    }
    return fields;
  }

  /**
   * Find `ref: "Target"` occurrences mapping each to its enclosing top-level
   * field. Detects array refs via `[{ ... }]` / `type: [ObjectId]` shapes and
   * tolerates `type: ObjectId, ref: 'X'` tuple syntax.
   */
  private parseRefs(
    block: string,
  ): Array<{ field: string; target: string; isArray: boolean }> {
    const inner = block.replace(/^\{/, "").replace(/\}$/, "");
    const refs: Array<{ field: string; target: string; isArray: boolean }> = [];
    for (const part of this.splitTopLevelArgs(inner)) {
      const seg = part.trim();
      if (!seg) continue;
      const km = seg.match(/^["'`]?([A-Za-z_$][\w$]*)["'`]?\s*:\s*([^]*)$/);
      if (!km) continue;
      const field = km[1];
      const value = km[2];
      const refMatch = value.match(/\bref\s*:\s*["'`]([A-Za-z_$][\w$]*)["'`]/);
      if (!refMatch) continue;
      // Array form: the value's outermost wrapper is `[` (e.g. `[{ ... }]`), or
      // it declares `type: [ObjectId]`.
      const isArray =
        /^\s*\[/.test(value) || /\btype\s*:\s*\[/.test(value);
      refs.push({ field, target: refMatch[1], isArray });
    }
    return refs;
  }

  /** Return the balanced `{ ... }` block beginning at `openIdx` (inclusive braces). */
  // ─── Drizzle ─────────────────────────────────────────────────────────────

  /**
   * `export const posts = pgTable("posts", { id: serial("id").primaryKey(),
   * authorId: integer("author_id").references(() => users.id) })` (and
   * `mysqlTable`/`sqliteTable`): the variable is the entity — queries name it
   * (`db.select().from(posts)`) — each property a column typed by its builder,
   * and `.references(() => users.id)` a many-to-one to the table it names.
   */
  private extractDrizzle(ctx: EntityExtractContext, entities: ClassInfo[], relations: EntityRelation[]): void {
    const logical = this.logicalLines(ctx.lines, { lineComment: SLASH_COMMENT });
    const TABLE_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pg|mysql|sqlite|singlestore)Table\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{/;
    for (const stmt of logical) {
      const m = TABLE_RE.exec(stmt.text);
      if (!m) continue;
      const name = m[1]!;
      const block = this.balancedBlock(stmt.text, stmt.text.indexOf("{", m.index + m[0].length - 1));
      const properties: PropertyInfo[] = [];
      const targets = new Set<string>();
      for (const field of splitTopLevel(block.slice(1, -1))) {
        const f = /^\s*["']?([A-Za-z_$][\w$]*)["']?\s*:\s*([A-Za-z_$][\w$]*)\s*\(/.exec(field);
        if (!f) continue;
        properties.push(this.column(f[1]!, f[2]!));
        const ref = /\.references\s*\(\s*\(\s*\)\s*(?::\s*[\w.<>]+\s*)?=>\s*([A-Za-z_$][\w$]*)\s*\./.exec(field);
        if (ref && ref[1] !== name) {
          relations.push({
            fromEntity: name,
            fromField: f[1]!,
            toEntity: ref[1]!,
            cardinality: "many-to-one",
            // The property holding the key (its column name is the builder's argument).
            foreignKey: f[1]!,
            orm: "drizzle",
            confidence: "EXTRACTED",
          });
          targets.add(ref[1]!);
        }
      }
      entities.push(this.entity({ name, orm: "drizzle", properties, implementsList: [...targets], line: stmt.line + 1, tableName: m[2]! }));
    }
  }

  private balancedBlock(text: string, openIdx: number): string {
    if (openIdx < 0) return "{}";
    const close = this.matchBracket(text, openIdx);
    if (close < 0) return text.slice(openIdx);
    return text.slice(openIdx, close + 1);
  }

  // ─── Shared inverse-side inference ────────────────────────────────────────

  /**
   * For relations where the same two entities reference each other in both
   * directions, fill in `inverseField` from the opposite side's field. Only
   * sets it when exactly one candidate exists, to avoid ambiguous guesses.
   */
  private linkInverseRelations(relations: EntityRelation[], orm: string): void {
    const own = relations.filter((r) => r.orm === orm);
    for (const rel of own) {
      if (rel.inverseField) continue;
      const candidates = own.filter(
        (other) =>
          other !== rel &&
          other.fromEntity === rel.toEntity &&
          other.toEntity === rel.fromEntity,
      );
      if (candidates.length === 1) {
        rel.inverseField = candidates[0].fromField;
        // Inferred by convention, not declared by the ORM.
        if (rel.confidence === "EXTRACTED") rel.confidence = "INFERRED";
      }
    }
  }

  // ─── Misc helpers ────────────────────────────────────────────────────────

  /** Add `toEntity` to an existing entity's implements list, when present. */
  private ensureImplements(entities: ClassInfo[], fromEntity: string, toEntity: string): void {
    const ent = entities.find((e) => e.name === fromEntity);
    if (ent && !ent.implements.includes(toEntity)) ent.implements.push(toEntity);
  }

  /**
   * Light type cleanup for a TS annotation, preserving union nullability info
   * (so `isOptional` can inspect it) but normalizing whitespace. Use `coreType`
   * for unwrapping to the bare entity identifier.
   */
  private cleanType(raw: string): string | null {
    const t = raw.replace(/\s+/g, " ").trim();
    return t || null;
  }

  private lcFirst(s: string): string {
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  }

  private escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

/** Split an object literal's interior on its top-level commas (brackets and strings respected). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out;
}

/** Sequelize's `{ tableName: "app_users" }` option (`define(…, {…}, { tableName })`, `init({…}, { sequelize, tableName })`). */
function sequelizeTableName(text: string): string | null {
  return /\btableName\s*:\s*["'`]([^"'`]+)["'`]/.exec(text)?.[1] ?? null;
}
