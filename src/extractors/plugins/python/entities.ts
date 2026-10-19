import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import { attributeRepositoryAccesses, splitTypeArgs, type RepositoryAccessKnobs } from "../shared/repository-access.js";
import type { ClassInfo, EntityRelation, FileAnalysis, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Extracts ORM entities + relations from Python source for the major
 * declarative ORMs: Django, SQLAlchemy (declarative — both classic `Column`
 * and SQLAlchemy 2.0 `Mapped[...] = mapped_column(...)` style), Pony ORM,
 * Peewee and Tortoise ORM.
 *
 * Class bodies are collapsed into balanced *logical* statements via
 * `this.logicalLines(body, { lineComment: ["#"] })` so that multiline field /
 * relationship calls (which span several physical lines in real code, and
 * which `PropertyInfo` does not carry) are recognized as a single statement.
 *
 * Returned entities reuse the existing class name so the project-level merge
 * enriches the existing node; related entity names are also placed in
 * `implementsList` for the class graph.
 *
 * Deliberately OUT OF SCOPE (documented limitations, not bugs):
 *   - Imperative SQLAlchemy `Table(...)` definitions (non-declarative). Only
 *     class-based declarative mappings are surfaced.
 *   - Django/SQLAlchemy *reverse* relations (e.g. Django's auto `*_set`,
 *     SQLAlchemy `backref` inverse side). We capture the owning side and record
 *     the inverse field name (`inverseField`) for project-level correlation,
 *     but do not synthesize a separate reverse `EntityRelation`.
 *   - pydantic `BaseModel`, `dataclass`/attrs, and plain classes are NOT
 *     entities — a genuine ORM marker is required.
 *   - Inner `Meta` classes, hybrid_property / synonym computed fields, and
 *     per-column constraint flags (unique=, db_index=, cascade=, lazy=,
 *     viewonly=) are not surfaced.
 *   - Inherited fields from abstract base models are not merged (each class is
 *     scanned in isolation).
 */
export class PythonEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["python"];

  /**
   * Project-level pass: the repository pattern over a generic base. A service
   * reaches the database as `self.repos.recipes.create(…)`: `repos` is a
   * property typed `AllRepositories` (declared on a base class in another
   * file), `recipes` a `@cached_property` returning `RepositoryRecipes`, and
   * `RepositoryRecipes(HouseholdRepositoryGeneric[Recipe, RecipeModel])` names
   * its table only through the type argument that is an entity. The per-file
   * pass sees none of that; this walks the typed member chain across files and
   * puts the entity on the call (mealie: 42 of 277 routes reached the database).
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    attributeRepositoryAccesses(analyses, PY_REPOSITORY_KNOBS);
  }

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    const importMods = this.importModules(ctx);
    const hasDjango = importMods.some((m) => m.startsWith("django"));
    const hasTortoise = importMods.some((m) => m.startsWith("tortoise"));
    const hasPeewee = importMods.some((m) => m.startsWith("peewee"));
    const hasPony = importMods.some((m) => m.startsWith("pony"));
    // Non-ORM `Model`-ish bases that must never be treated as entities.
    const nonOrmBases = this.collectNonOrmBases(ctx);

    for (const cls of ctx.analysis.classes) {
      try {
        const body = this.bodyOf(ctx, cls);
        // Collapse physical lines into balanced logical statements so multiline
        // field / relationship calls become a single entry. `line` is the
        // 0-based offset within `body`.
        const logical = this.logicalLines(body, { lineComment: ["#"] });
        const declLine = logical[0]?.text ?? body[0] ?? "";
        // Skip the class declaration statement itself; members are the rest.
        const members = logical.slice(1).map((ll) => ll.text);

        const orm = this.classifyOrm(cls, declLine, members, {
          hasDjango,
          hasTortoise,
          hasPeewee,
          hasPony,
          nonOrmBases,
        });
        if (!orm) continue;

        const properties: PropertyInfo[] = [];
        const targets = new Set<string>();
        const classRelations: EntityRelation[] = [];
        // Bare-`Model` bases with no import context are AMBIGUOUS — we record
        // that on every relation derived from such a class.
        const ambiguous = orm.ambiguous === true;

        switch (orm.id) {
          case "django":
            this.extractDjango(cls, members, properties, classRelations, targets, ambiguous);
            break;
          case "sqlalchemy":
            this.extractSqlAlchemy(cls, members, properties, classRelations, targets);
            break;
          case "pony-orm":
            this.extractPony(cls, members, properties, classRelations, targets);
            break;
          case "peewee":
            this.extractPeewee(cls, members, properties, classRelations, targets, ambiguous);
            break;
          case "tortoise-orm":
            this.extractTortoise(cls, members, properties, classRelations, targets, ambiguous);
            break;
        }

        entities.push(
          this.entity({
            name: cls.name,
            orm: orm.id,
            properties,
            implementsList: [...targets],
            line: cls.line,
            endLine: cls.endLine,
            tableName: pythonTableName(body.join("\n")),
          }),
        );
        for (const rel of classRelations) relations.push(rel);
      } catch {
        // Never throw — skip anything we can't parse.
      }
    }

    return { entities, relations };
  }

  // ─── ORM classification ──────────────────────────────────────────────────

  /**
   * Decide whether a class is a genuine ORM entity, and which ORM. Returns the
   * ORM id plus an `ambiguous` flag (true when a bare `Model` base could not be
   * disambiguated from imports and had to be resolved by body heuristics).
   *
   * False-positive guard: pydantic `BaseModel`, `dataclass`/attrs, and plain
   * classes are explicitly rejected — a real ORM marker (recognized base or an
   * ORM field/relationship call in the body) is required.
   */
  private classifyOrm(
    cls: ClassInfo,
    declLine: string,
    members: string[],
    flags: {
      hasDjango: boolean;
      hasTortoise: boolean;
      hasPeewee: boolean;
      hasPony: boolean;
      nonOrmBases: Set<string>;
    },
  ): { id: string; ambiguous?: boolean } | null {
    const base = cls.extends ?? "";
    const bases = `${base} ${declLine}`;
    const bodyText = members.join("\n");

    // Hard reject: known non-ORM bases (pydantic, dataclasses, plain object).
    const lastBaseSeg = (base.split(".").pop() ?? base).trim();
    if (flags.nonOrmBases.has(lastBaseSeg)) return null;
    if (/\bBaseModel\b/.test(bases)) return null; // pydantic / starlette / FastAPI

    // Pony: subclasses `db.Entity` (the db instance name varies → match *.Entity).
    if (/\bdb\.Entity\b/.test(bases) || /\.Entity\b/.test(declLine) || /\(\s*db\.Entity\b/.test(declLine)) {
      return { id: "pony-orm" };
    }

    // The declarative base itself (`class Base(DeclarativeBase): pass`) maps no
    // table — it is what the entities extend.
    if (/^(?:DeclarativeBase|DeclarativeBaseNoMeta|AsyncAttrs|MappedAsDataclass)$/.test(lastBaseSeg) &&
      !/\b__tablename__\s*=|\bmapped_column\s*\(|=\s*(?:\w+\.)?Column\s*\(|\bMapped\s*\[/.test(bodyText)) {
      return null;
    }

    // Flask-SQLAlchemy: `class User(db.Model)` with `db.Column(...)` fields.
    if (/\bdb\.Model\b/.test(base) || /=\s*(?:db|sa)\.Column\s*\(/.test(bodyText)) {
      return { id: "sqlalchemy" };
    }

    // `models.Model` is shared by Django and Tortoise — disambiguate via imports.
    if (/\bmodels\.Model\b/.test(base) || /\bmodels\.Model\b/.test(declLine)) {
      return flags.hasTortoise ? { id: "tortoise-orm" } : { id: "django" };
    }

    // SQLAlchemy declarative: a `Base`/`DeclarativeBase` base, OR a body marker
    // (`__tablename__`, `mapped_column(`, classic `Column(`, `relationship(`).
    if (
      /\b(Base|DeclarativeBase)\b/.test(base) ||
      /\b__tablename__\s*=/.test(bodyText) ||
      /\bmapped_column\s*\(/.test(bodyText) ||
      /=\s*Column\s*\(/.test(bodyText) ||
      /\bMapped\s*\[/.test(bodyText)
    ) {
      return { id: "sqlalchemy" };
    }

    // Bare `Model` base (e.g. `from django.db.models import Model`, Tortoise's
    // `Model`, or Peewee's `Model`). Prefer import-derived ORM, then body
    // heuristics; flag AMBIGUOUS when only heuristics could resolve it.
    if (/\bModel\b/.test(base) || /\(\s*Model\s*[),]/.test(declLine)) {
      if (flags.hasTortoise && !flags.hasDjango && !flags.hasPeewee) return { id: "tortoise-orm" };
      if (flags.hasPeewee && !flags.hasDjango && !flags.hasTortoise) return { id: "peewee" };
      if (flags.hasDjango && !flags.hasTortoise && !flags.hasPeewee) return { id: "django" };

      // Imports ambiguous or absent → fall back to body field syntax.
      if (/\bfields\.\w+\s*\(/.test(bodyText)) return { id: "tortoise-orm", ambiguous: true };
      if (/\bmodels\.\w*Field\s*\(/.test(bodyText)) return { id: "django", ambiguous: true };
      if (/=\s*\w+Field\s*\(/.test(bodyText)) return { id: "peewee", ambiguous: true };
      // Recognized base but no parseable fields — still an entity, AMBIGUOUS.
      if (flags.hasDjango || flags.hasTortoise || flags.hasPeewee) {
        return { id: flags.hasTortoise ? "tortoise-orm" : flags.hasPeewee ? "peewee" : "django", ambiguous: true };
      }
      return null;
    }

    return null;
  }

  // ─── Django ────────────────────────────────────────────────────────────────

  private extractDjango(
    cls: ClassInfo,
    members: string[],
    properties: PropertyInfo[],
    relations: EntityRelation[],
    targets: Set<string>,
    ambiguous: boolean,
  ): void {
    const confidence: EntityRelation["confidence"] = ambiguous ? "AMBIGUOUS" : "EXTRACTED";
    for (const raw of members) {
      // `name = models.<Kind>(<args>)` — args may span lines (already collapsed).
      const m = raw.match(/^\s*([A-Za-z_]\w*)\s*=\s*models\.(\w+)\s*\(([\s\S]*)\)\s*$/);
      if (!m) continue;
      const field = m[1]!;
      const kind = m[2]!;
      const args = m[3] ?? "";

      // Django relations accept the target as a positional arg or `to=`.
      const target = this.djangoTarget(args);
      const relatedName = this.kwargString(args, "related_name");

      if (kind === "ForeignKey") {
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "many-to-one", {
            foreignKey: `${field}_id`,
            inverseField: relatedName,
            optional: /\bnull\s*=\s*True\b/.test(args),
            orm: "django",
            confidence,
          }),
        );
        targets.add(target);
      } else if (kind === "OneToOneField") {
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "one-to-one", {
            foreignKey: `${field}_id`,
            inverseField: relatedName,
            optional: /\bnull\s*=\s*True\b/.test(args),
            orm: "django",
            confidence,
          }),
        );
        targets.add(target);
      } else if (kind === "ManyToManyField") {
        if (!target) continue;
        // `through=` names an explicit join/through model.
        const through = this.kwargTarget(args, "through");
        relations.push(
          this.relation(cls.name, field, target, "many-to-many", {
            inverseField: relatedName,
            joinTable: through,
            orm: "django",
            confidence,
          }),
        );
        targets.add(target);
      } else if (/Field$/.test(kind)) {
        // Scalar / value column (CharField, IntegerField, JSONField, …).
        properties.push(this.column(field, kind));
      }
    }
  }

  // ─── SQLAlchemy (classic Column + 2.0 Mapped/mapped_column) ──────────────

  private extractSqlAlchemy(
    cls: ClassInfo,
    members: string[],
    properties: PropertyInfo[],
    relations: EntityRelation[],
    targets: Set<string>,
  ): void {
    for (const raw of members) {
      // Capture an optional `: <annotation>` and the RHS call separately so we
      // can use the SQLAlchemy 2.0 `Mapped[...]` annotation for cardinality.
      const m = raw.match(/^\s*([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*([\s\S]*)$/);
      if (!m) continue;
      const field = m[1]!;
      const annotation = (m[2] ?? "").trim();
      // `db.Column(db.Integer, db.ForeignKey("users.id"))` (Flask-SQLAlchemy) and
      // `sa.Column(sa.String)` read as their bare SQLAlchemy names.
      const rhs = (m[3] ?? "").trim().replace(/\b(?:db|sa|sqlalchemy|orm)\.(?=[A-Za-z_])/g, "");

      // ── relationship(...) ── (classic or 2.0 `Mapped[...] = relationship(...)`)
      const relM = rhs.match(/^relationship\s*\(([\s\S]*)\)\s*$/);
      if (relM) {
        const args = relM[1] ?? "";
        // Target: positional/`argument=` arg, else from the Mapped[...] annotation.
        const target = this.firstTarget(args) ?? this.coreType(annotation);
        if (!target) continue;

        // Cardinality: a `Mapped[list[X]]`/`List[X]` annotation, or a `uselist`
        // arg, indicates the collection side; otherwise scalar (one-to-one).
        const annIsCollection = /\b(list|List|set|Set)\b/.test(annotation);
        const uselistFalse = /\buselist\s*=\s*False\b/.test(args);
        const uselistTrue = /\buselist\s*=\s*True\b/.test(args);
        let cardinality: EntityRelation["cardinality"];
        if (uselistFalse) cardinality = "one-to-one";
        else if (annIsCollection || uselistTrue) cardinality = "one-to-many";
        else if (annotation) cardinality = "many-to-one";
        else cardinality = "one-to-many"; // SQLAlchemy default is a collection

        // back_populates / backref name the inverse field; secondary is the
        // join table (→ many-to-many).
        const inverse = this.kwargString(args, "back_populates") ?? this.backrefName(args);
        const secondary = this.kwargTarget(args, "secondary");
        if (secondary) cardinality = "many-to-many";

        relations.push(
          this.relation(cls.name, field, target, cardinality, {
            inverseField: inverse,
            joinTable: secondary,
            orm: "sqlalchemy",
            // EXTRACTED when target came from an explicit arg; INFERRED when it
            // was derived from the Mapped[...] annotation only.
            confidence: this.firstTarget(args) ? "EXTRACTED" : "INFERRED",
          }),
        );
        targets.add(target);
        continue;
      }

      // ── Column(...) / mapped_column(...) ──
      const colM = rhs.match(/^(?:Column|mapped_column)\s*\(([\s\S]*)\)\s*$/);
      if (colM) {
        const args = colM[1] ?? "";
        // Type fidelity: prefer the explicit column type; fall back to the
        // Mapped[...] annotation's core type; for an FK-only column keep
        // "ForeignKey" rather than dropping the type entirely.
        const inlineFk = args.match(/ForeignKey\s*\(\s*["']([^"']+)["']/);
        let type = this.sqlaColumnType(args);
        if (!type) type = this.coreType(annotation);
        if (!type && inlineFk) type = "ForeignKey";
        properties.push(this.column(field, type));

        // Inline `ForeignKey("table.col")` → many-to-one relation.
        if (inlineFk) {
          const table = (inlineFk[1]!.split(".")[0] ?? "").trim();
          const target = this.tableToEntity(table);
          if (target) {
            relations.push(
              this.relation(cls.name, field, target, "many-to-one", {
                foreignKey: field,
                optional: /\bnullable\s*=\s*True\b/.test(args),
                orm: "sqlalchemy",
                // Target inferred from the table name by convention.
                confidence: "INFERRED",
              }),
            );
            targets.add(target);
          }
        }
        continue;
      }
    }
  }

  // ─── Pony ORM ──────────────────────────────────────────────────────────────

  private extractPony(
    cls: ClassInfo,
    members: string[],
    properties: PropertyInfo[],
    relations: EntityRelation[],
    targets: Set<string>,
  ): void {
    for (const raw of members) {
      const m = raw.match(/^\s*([A-Za-z_]\w*)\s*=\s*(Required|Optional|Set|PrimaryKey)\s*\(([\s\S]*)\)\s*$/);
      if (!m) continue;
      const field = m[1]!;
      const kind = m[2]!;
      const args = m[3] ?? "";
      const firstArg = this.firstArg(args);

      if (kind === "Set") {
        // `Set(X)` is the collection side — one-to-many (or the owning side of a
        // many-to-many when the inverse is also a Set; resolved at project level).
        const target = this.targetFromArg(firstArg);
        if (target) {
          relations.push(
            this.relation(cls.name, field, target, "one-to-many", {
              inverseField: this.kwargString(args, "reverse"),
              orm: "pony-orm",
            }),
          );
          targets.add(target);
        }
        continue;
      }

      // Required/Optional/PrimaryKey: entity-typed arg ⇒ relation, else a column.
      const entityTarget = this.entityTypedArg(firstArg);
      if (entityTarget) {
        relations.push(
          this.relation(cls.name, field, entityTarget, "many-to-one", {
            inverseField: this.kwargString(args, "reverse"),
            orm: "pony-orm",
            optional: kind === "Optional",
          }),
        );
        targets.add(entityTarget);
      } else {
        properties.push(this.column(field, this.scalarType(firstArg)));
      }
    }
  }

  // ─── Peewee ──────────────────────────────────────────────────────────────

  private extractPeewee(
    cls: ClassInfo,
    members: string[],
    properties: PropertyInfo[],
    relations: EntityRelation[],
    targets: Set<string>,
    ambiguous: boolean,
  ): void {
    const confidence: EntityRelation["confidence"] = ambiguous ? "AMBIGUOUS" : "EXTRACTED";
    for (const raw of members) {
      const m = raw.match(/^\s*([A-Za-z_]\w*)\s*=\s*(\w+)\s*\(([\s\S]*)\)\s*$/);
      if (!m) continue;
      const field = m[1]!;
      const kind = m[2]!;
      const args = m[3] ?? "";

      if (kind === "ForeignKeyField" || kind === "DeferredForeignKey") {
        const target = this.firstTarget(args);
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "many-to-one", {
            foreignKey: `${field}_id`,
            // `backref` / legacy `related_name` name the reverse accessor.
            inverseField: this.kwargString(args, "backref") ?? this.kwargString(args, "related_name"),
            orm: "peewee",
            confidence,
          }),
        );
        targets.add(target);
      } else if (kind === "ManyToManyField") {
        const target = this.firstTarget(args);
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "many-to-many", {
            // Peewee names the join model via `through_model=`.
            joinTable: this.kwargTarget(args, "through_model"),
            inverseField: this.kwargString(args, "backref"),
            orm: "peewee",
            confidence,
          }),
        );
        targets.add(target);
      } else if (/Field$/.test(kind)) {
        // Scalar / value column. (Non-Field calls are ignored to avoid false
        // positives from unrelated assignments.)
        properties.push(this.column(field, kind));
      }
    }
  }

  // ─── Tortoise ORM ──────────────────────────────────────────────────────────

  private extractTortoise(
    cls: ClassInfo,
    members: string[],
    properties: PropertyInfo[],
    relations: EntityRelation[],
    targets: Set<string>,
    ambiguous: boolean,
  ): void {
    const confidence: EntityRelation["confidence"] = ambiguous ? "AMBIGUOUS" : "EXTRACTED";
    for (const raw of members) {
      const m = raw.match(/^\s*([A-Za-z_]\w*)\s*=\s*fields\.(\w+)\s*\(([\s\S]*)\)\s*$/);
      if (!m) continue;
      const field = m[1]!;
      const kind = m[2]!;
      const args = m[3] ?? "";

      if (kind === "ForeignKeyField") {
        const target = this.firstTarget(args);
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "many-to-one", {
            foreignKey: `${field}_id`,
            inverseField: this.kwargString(args, "related_name"),
            optional: /\bnull\s*=\s*True\b/.test(args),
            orm: "tortoise-orm",
            confidence,
          }),
        );
        targets.add(target);
      } else if (kind === "OneToOneField") {
        const target = this.firstTarget(args);
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "one-to-one", {
            foreignKey: `${field}_id`,
            inverseField: this.kwargString(args, "related_name"),
            optional: /\bnull\s*=\s*True\b/.test(args),
            orm: "tortoise-orm",
            confidence,
          }),
        );
        targets.add(target);
      } else if (kind === "ManyToManyField") {
        const target = this.firstTarget(args);
        if (!target) continue;
        relations.push(
          this.relation(cls.name, field, target, "many-to-many", {
            // `through=` names the explicit join model.
            joinTable: this.kwargTarget(args, "through"),
            inverseField: this.kwargString(args, "related_name"),
            orm: "tortoise-orm",
            confidence,
          }),
        );
        targets.add(target);
      } else if (/Field$/.test(kind)) {
        properties.push(this.column(field, kind));
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Module names imported in this file (import source strings). */
  private importModules(ctx: EntityExtractContext): string[] {
    const mods: string[] = [];
    for (const imp of ctx.analysis.imports) {
      if (imp.source) mods.push(imp.source);
    }
    return mods;
  }

  /**
   * Collect base-class names that are imported from known non-ORM libraries
   * (pydantic / starlette / FastAPI `BaseModel`, dataclasses). Used to hard-
   * reject schema/value classes that look like models but are not entities.
   */
  private collectNonOrmBases(ctx: EntityExtractContext): Set<string> {
    const bases = new Set<string>();
    for (const imp of ctx.analysis.imports) {
      const src = imp.source ?? "";
      const fromPydantic = /^pydantic\b/.test(src) || /^starlette\b/.test(src) || /^fastapi\b/.test(src);
      const fromDataclasses = /^dataclasses\b/.test(src) || /^attr\b/.test(src) || /^attrs\b/.test(src);
      if (!fromPydantic && !fromDataclasses) continue;
      for (const spec of imp.specifiers ?? []) {
        // `specifiers` may be plain names or "orig as alias" — keep the alias.
        const name = (spec.split(/\s+as\s+/).pop() ?? spec).trim();
        if (name) bases.add(name);
      }
    }
    // Always treat pydantic's canonical name as non-ORM even if aliased away.
    bases.add("BaseModel");
    return bases;
  }

  /** Build an EntityRelation with EXTRACTED confidence by default. */
  private relation(
    fromEntity: string,
    fromField: string,
    toEntity: string,
    cardinality: EntityRelation["cardinality"],
    opts: {
      foreignKey?: string | null;
      inverseField?: string | null;
      joinTable?: string | null;
      optional?: boolean;
      orm?: string;
      confidence?: EntityRelation["confidence"];
    } = {},
  ): EntityRelation {
    return {
      fromEntity,
      fromField,
      toEntity,
      cardinality,
      foreignKey: opts.foreignKey ?? null,
      inverseField: opts.inverseField ?? null,
      joinTable: opts.joinTable ?? null,
      optional: opts.optional ?? false,
      orm: opts.orm,
      confidence: opts.confidence ?? "EXTRACTED",
    };
  }

  /**
   * Resolve a relation target from a call's argument list — picks the first
   * positional argument and derives an entity name from it (quoted string ref
   * like "app.User" / "models.User" or a bare/dotted identifier).
   */
  private firstTarget(args: string): string | null {
    return this.targetFromArg(this.firstArg(args));
  }

  /**
   * Django target resolution: the related model is the first positional arg OR
   * the `to=` keyword arg (`models.ForeignKey(to="Author", ...)`).
   */
  private djangoTarget(args: string): string | null {
    return this.firstTarget(args) ?? this.kwargTarget(args, "to");
  }

  /** The first *positional* argument token of an argument list (best-effort). */
  private firstArg(args: string): string {
    const first = this.splitArgs(args)[0] ?? "";
    // A leading keyword argument is not positional.
    return /^[A-Za-z_]\w*\s*=/.test(first) ? "" : first;
  }

  /**
   * Split an argument list into top-level arguments, ignoring commas inside
   * brackets and string literals (string-aware, escape-aware).
   */
  private splitArgs(args: string): string[] {
    const out: string[] = [];
    const trimmed = args.trim();
    if (!trimmed) return out;
    let depth = 0;
    let quote = "";
    let start = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
      } else if (ch === "," && depth === 0) {
        out.push(trimmed.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(trimmed.slice(start).trim());
    return out;
  }

  /** Raw value of a `name=...` keyword arg in an argument list, or null. */
  private kwargValue(args: string, name: string): string | null {
    for (const arg of this.splitArgs(args)) {
      const m = arg.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);
      if (m && m[1] === name) return (m[2] ?? "").trim();
    }
    return null;
  }

  /** String value of a keyword arg (unwrapping quotes), or null. */
  private kwargString(args: string, name: string): string | null {
    const v = this.kwargValue(args, name);
    if (!v) return null;
    const q = v.match(/^["']([^"']*)["']$/);
    const s = q ? q[1]! : v;
    return s ? s : null;
  }

  /** Entity-name value of a keyword arg (e.g. `through="app.PostTag"`), or null. */
  private kwargTarget(args: string, name: string): string | null {
    const v = this.kwargValue(args, name);
    return v ? this.targetFromArg(v) : null;
  }

  /**
   * SQLAlchemy `backref="name"` may be a plain string or `backref("name", ...)`.
   * Extract the inverse field name from either form.
   */
  private backrefName(args: string): string | null {
    const v = this.kwargValue(args, "backref");
    if (!v) return null;
    const call = v.match(/^backref\s*\(\s*["']([^"']+)["']/);
    if (call) return call[1]!;
    const q = v.match(/^["']([^"']+)["']$/);
    return q ? q[1]! : null;
  }

  /**
   * Derive an entity name from a target argument: strips quotes, takes the last
   * dotted segment ("app.User" / "models.User" → "User"). Returns null when the
   * argument isn't a usable target (e.g. "self", a keyword arg, empty).
   */
  private targetFromArg(arg: string): string | null {
    let a = arg.trim();
    if (!a) return null;
    // Drop a trailing keyword-arg assignment if present (e.g. `to=...`).
    if (/^\w+\s*=/.test(a)) return null;
    const quoted = a.match(/^["']([^"']+)["']$/);
    if (quoted) a = quoted[1]!;
    // Take the last dotted segment ("app.User" → "User").
    const seg = a.split(".").pop() ?? a;
    const name = seg.trim();
    if (!name || name === "self" || name === "this") return null;
    // Reject scalar / python builtin types — these aren't entity references.
    if (this.isScalarType(name)) return null;
    if (!/^[A-Za-z_]\w*$/.test(name)) return null;
    return name;
  }

  /**
   * For Pony Required/Optional: only treat the arg as an entity relation when
   * it is a Capitalized identifier or a quoted name (not str/int/datetime/…).
   */
  private entityTypedArg(arg: string): string | null {
    const a = arg.trim();
    if (!a) return null;
    const quoted = a.match(/^["']([^"']+)["']$/);
    if (quoted) {
      const seg = quoted[1]!.split(".").pop() ?? quoted[1]!;
      return this.isScalarType(seg) ? null : seg;
    }
    const seg = a.split(".").pop() ?? a;
    const name = seg.trim();
    if (!/^[A-Z]\w*$/.test(name)) return null; // entity types are Capitalized
    if (this.isScalarType(name)) return null;
    return name;
  }

  /** First positional arg of a SQLAlchemy `Column(...)` as the column type token. */
  private sqlaColumnType(args: string): string | null {
    const first = this.firstArg(args);
    if (!first) return null;
    // A column whose first positional arg is `ForeignKey(...)` carries no own
    // type token here — the caller falls back to the Mapped annotation or
    // "ForeignKey" so the type is never dropped.
    if (/^ForeignKey\b/.test(first)) return null;
    // Strip a call's parens: String(50) → String, Numeric(10, 2) → Numeric.
    const m = first.match(/^([A-Za-z_]\w*)/);
    return m ? m[1]! : null;
  }

  /** Map a Pony scalar arg (str/int/…) to a type token, else null. */
  private scalarType(arg: string): string | null {
    const m = arg.trim().match(/^([A-Za-z_]\w*)/);
    const t = m ? m[1]! : "";
    return this.isScalarType(t) ? t : (t || null);
  }

  /**
   * Loose check for Python scalar / stdlib value types (not entities). Unwraps
   * `Optional[...]`, `List[...]`, `int | None`, quotes and dotted prefixes via
   * `coreType` first so annotated 2.0-style fields classify correctly.
   */
  private isScalarType(name: string): boolean {
    // Reduce wrappers (`Optional[int]`, `int | None`, `list[str]`) to the core.
    const core = this.coreType(name) ?? name;
    return /^(str|int|float|bool|bytes|bytearray|complex|datetime|date|time|timedelta|Decimal|UUID|uuid|Json|json|LongStr|LongUnicode|object|None|dict|list|set|tuple)$/i.test(
      core,
    );
  }

  /**
   * Derive an entity name from a SQLAlchemy table name ("user" / "users" →
   * "User"). Loose singularize (drop a trailing "s") + capitalize. INFERRED.
   */
  private tableToEntity(table: string): string | null {
    let t = table.trim();
    if (!t) return null;
    // Drop schema prefix if present ("public.user" → "user").
    t = t.split(".").pop() ?? t;
    if (!/^[A-Za-z_]\w*$/.test(t)) return null;
    // Loose singularize.
    if (/ies$/.test(t)) t = t.replace(/ies$/, "y");
    else if (/sses$/.test(t)) t = t.replace(/es$/, "");
    else if (/s$/.test(t) && !/ss$/.test(t)) t = t.replace(/s$/, "");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
}

// ─── Generic repository access (project-level) ──────────────────────────────

/** The Python spelling: `RepositoryRecipes(HouseholdRepositoryGeneric[Recipe, RecipeModel])`, `self.` members, `__init__`. */
const PY_REPOSITORY_KNOBS: RepositoryAccessKnobs = {
  language: "python",
  genericArgs: (written) => {
    const m = /\b\w*(?:Repository|Repo|Store|Dao)\w*\s*\[(.+)\]\s*$/.exec(written.trim());
    return m ? splitTypeArgs(m[1]!) : null;
  },
  selfHeads: new Set(["self", "cls"]),
  memberKey: (name) => name,
  isConstructor: (m) => m.name === "__init__",
  verbs: /^(get|find|fetch|create|update|delete|patch|save|add|remove|insert|upsert|list|page|count|exists|query|all|first|by_|search)\w*$/,
  writeVerbs: /^(create|update|delete|patch|save|add|remove|insert|upsert)/,
};

/**
 * The table a model names: SQLAlchemy `__tablename__ = "…"`, Django's
 * `class Meta: db_table = "…"`, peewee `table_name`, tortoise `table`, Pony
 * `_table_`. The Meta forms only inside a nested `class Meta`.
 */
function pythonTableName(body: string): string | null {
  const direct = /^\s*(?:__tablename__|_table_)\s*(?::\s*\w+\s*)?=\s*["']([^"']+)["']/m.exec(body);
  if (direct) return direct[1]!;
  const meta = /^([ \t]*)class[ \t]+Meta\b[^\n]*:[ \t]*\n((?:\1[ \t]+[^\n]*(?:\n|$))*)/m.exec(body);
  const inMeta = meta ? /^\s*(?:db_table|table_name|table)\s*=\s*["']([^"']+)["']/m.exec(meta[2]!) : null;
  return inMeta?.[1] ?? null;
}
