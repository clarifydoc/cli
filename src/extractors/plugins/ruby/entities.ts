import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, DataSourceInfo, EntityRelation, FileAnalysis, Language, PropertyInfo } from "../../../types/analysis.js";
import { isRailsSchemaFile, joinSchemaColumns, parseRailsSchema } from "./schema.js";

/**
 * Extracts ActiveRecord (Rails) and Sequel::Model entities + their
 * associations from Ruby source.
 *
 * Ruby columns live in the DB schema (db/schema.rb, migrations) rather than
 * the model class, so `properties` is usually empty — the value here is the
 * relation graph derived from association macros (`has_many`, `belongs_to`,
 * `one_to_many`, …). A class is treated as an entity when its superclass is a
 * known ORM base (or, for single-table inheritance, a subclass of another
 * entity discovered in the same file).
 *
 * Associations are parsed from *logical* statements (multiline-aware) so that
 * the common Rails style of spreading one macro across several physical lines —
 *
 *   has_many :comments,
 *     class_name: "Comment",
 *     foreign_key: "author_id",
 *     dependent: :destroy
 *
 * — is collapsed into a single record before any regex runs.
 */
export class RubyEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["ruby"];

  /** Ruby uses `#` for line comments. */
  private static readonly LINE_COMMENT = ["#"] as const;

  /** The association macros we understand (ActiveRecord + Sequel). */
  private static readonly ASSOCIATION_MACROS = new Set<string>([
    "has_many",
    "belongs_to",
    "has_one",
    "has_and_belongs_to_many",
    "one_to_many",
    "many_to_one",
    "one_to_one",
    "many_to_many",
  ]);

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    // The schema dump has no model classes — only `create_table` blocks. Parse
    // its columns so the project-level join can attach them to the models.
    if (isRailsSchemaFile(ctx.sourceText)) {
      let schemaTables;
      try {
        schemaTables = parseRailsSchema(ctx.lines);
      } catch {
        schemaTables = undefined;
      }
      return { entities, relations, schemaTables };
    }

    // Pass 1: classify every class as an ORM entity or not. We need this map up
    // front so single-table-inheritance subclasses (`class Admin < User`) can be
    // recognized as entities once `User` is known to be one. We iterate to a
    // fixed point so chains (A < B < ApplicationRecord) all resolve.
    const ormByName = this.classifyEntities(ctx);

    for (const cls of ctx.analysis.classes) {
      const orm = ormByName.get(cls.name);
      if (!orm) continue;

      const targets = new Set<string>();
      let body: string[];
      try {
        body = this.bodyOf(ctx, cls);
      } catch {
        continue;
      }

      // Collapse physical lines into balanced logical statements so multiline
      // associations become a single entry, and inline `#` comments are stripped.
      // `logicalLines` joins on unbalanced brackets; we then layer Ruby's
      // trailing-comma continuation rule on top (`has_many :x,` \n `class_name:…`).
      let statements: Array<{ text: string; line: number }>;
      try {
        statements = this.mergeCommaContinuations(
          this.logicalLines(body, { lineComment: RubyEntityExtractor.LINE_COMMENT }),
        );
      } catch {
        statements = [];
      }

      for (const stmt of statements) {
        try {
          const rel = this.parseAssociation(cls.name, stmt.text, orm);
          if (rel) {
            relations.push(rel);
            targets.add(rel.toEntity);
          }
        } catch {
          // skip unparseable statement
        }
      }

      // An explicit `self.table_name = "x"` overrides the pluralization
      // convention; carry it as a `table:<name>` decorator so the project-level
      // schema join keys on the real table instead of guessing.
      const tableName = this.tableNameOverride(body);

      entities.push(
        this.entity({
          name: cls.name,
          orm,
          properties: [] as PropertyInfo[],
          implementsList: [...targets],
          extends: cls.extends ?? null,
          line: cls.line,
          endLine: cls.endLine,
          extraDecorators: tableName ? [`table:${tableName}`] : undefined,
        }),
      );
    }

    return { entities, relations };
  }

  /**
   * Project-level pass: join `db/schema.rb` columns onto the model entities
   * (whose class bodies declare none). Per-file extraction can't do this — the
   * schema lives in a different file from the models.
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    joinSchemaColumns(analyses);
    resolveChainAccesses(analyses);
  }

  /**
   * Merge logical statements where Ruby continues a statement onto the next
   * physical line via a trailing comma (balanced brackets, so `logicalLines`
   * already split them). Also handles a leading-operator continuation on the
   * *next* line (a comma or `.`), which Ruby treats as a continuation too.
   */
  private mergeCommaContinuations(
    statements: Array<{ text: string; line: number }>,
  ): Array<{ text: string; line: number }> {
    const out: Array<{ text: string; line: number }> = [];
    for (const stmt of statements) {
      const prev = out[out.length - 1];
      const trimmed = stmt.text.trim();
      const prevTrailingComma = prev !== undefined && /,\s*$/.test(prev.text.trim());
      const leadsWithContinuation = /^[,.]/.test(trimmed);
      if (prev !== undefined && (prevTrailingComma || leadsWithContinuation)) {
        prev.text = prev.text.replace(/\s*$/, "") + " " + trimmed;
      } else {
        out.push({ text: stmt.text, line: stmt.line });
      }
    }
    return out;
  }

  // ─── Entity classification ────────────────────────────────────────────────

  /**
   * Build a `className → orm` map. A class is an entity when its superclass is a
   * known ORM base, OR (single-table inheritance) when its superclass is itself
   * an entity. We iterate to a fixed point so multi-level STI chains resolve.
   */
  private classifyEntities(ctx: EntityExtractContext): Map<string, string> {
    const orm = new Map<string, string>();

    // Seed with direct ORM-base subclasses (e.g. `< ApplicationRecord`).
    for (const cls of ctx.analysis.classes) {
      const direct = this.ormForBase(cls.extends);
      if (direct) orm.set(cls.name, direct);
    }

    // DSL-presence pass — a class that uses ActiveRecord / Sequel DSL is an
    // entity even when it extends a PROJECT base class (`< IdaModel`) defined in
    // another file, which per-file analysis can't resolve by name. This is the
    // common Rails case (most apps subclass an `ApplicationRecord`-derived base),
    // so without it the bulk of real models — and all their associations — are
    // missed. We read each class body once and look for unmistakable ORM DSL.
    for (const cls of ctx.analysis.classes) {
      if (orm.has(cls.name)) continue;
      let body: string;
      try {
        body = this.bodyOf(ctx, cls).join("\n");
      } catch {
        continue;
      }
      const dsl = this.ormFromDsl(body, cls.extends);
      if (dsl) orm.set(cls.name, dsl);
    }

    // Propagate to STI subclasses until no new entity is discovered. Runs after
    // the DSL pass so a subclass of a DSL-detected model is also recognized.
    let changed = true;
    while (changed) {
      changed = false;
      for (const cls of ctx.analysis.classes) {
        if (orm.has(cls.name)) continue;
        const parent = this.bareSuperclassName(cls.extends);
        if (parent && orm.has(parent)) {
          orm.set(cls.name, orm.get(parent)!);
          changed = true;
        }
      }
    }

    return orm;
  }

  /**
   * Classify a class as an ORM entity from the DSL in its body (and as a last
   * resort a base-class NAME convention), independent of the base class being
   * resolvable. Sequel-specific association macros win; otherwise any of the
   * unmistakable ActiveRecord markers (associations, validations, enums,
   * lifecycle callbacks, table config, `acts_as_*`) classify it as ActiveRecord.
   */
  private ormFromDsl(body: string, superclass: string | null): string | null {
    if (/(^|\n)\s*(one_to_many|many_to_one|one_to_one|many_to_many)\s+:/.test(body)) {
      return "sequel";
    }
    if (
      /(^|\n)\s*(belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:/.test(body) ||
      /(^|\n)\s*validates(_[a-z]+)?\s+[:'"]/.test(body) ||
      /(^|\n)\s*enum\s+[:\w]/.test(body) ||
      /(^|\n)\s*default_scope\b/.test(body) ||
      /(^|\n)\s*acts_as_\w+/.test(body) ||
      /(^|\n)\s*self\.(table_name|primary_key|inheritance_column)\s*=/.test(body) ||
      /(^|\n)\s*(before|after|around)_(save|create|update|destroy|validation|commit)\b/.test(body)
    ) {
      return "active-record";
    }
    // Base-class name convention: a superclass that looks like an AR base
    // (`ApplicationRecord` under any namespace, or a project `*Record` base).
    const bare = this.bareSuperclassName(superclass);
    if (bare && (/Record$/.test(bare) || bare === "ApplicationRecord")) return "active-record";
    return null;
  }

  /**
   * Read an explicit `self.table_name = "..."` / `:symbol` assignment from a
   * class body, or null. Sequel's `set_dataset :name` form is handled too.
   */
  private tableNameOverride(body: string[]): string | null {
    for (const raw of body) {
      const m =
        /^\s*self\.table_name\s*=\s*(?:"([^"]+)"|'([^']+)'|:([A-Za-z_]\w*))/.exec(raw) ??
        /^\s*set_dataset\s+(?::([A-Za-z_]\w*)|"([^"]+)"|'([^']+)')/.exec(raw);
      if (m) return (m[1] ?? m[2] ?? m[3] ?? m[4])!;
    }
    return null;
  }

  /** Map a Ruby ORM *base* superclass to its ORM id, or null when not a base. */
  private ormForBase(superclass: string | null): string | null {
    if (!superclass) return null;
    const s = superclass.trim();
    if (s === "ApplicationRecord" || s === "ActiveRecord::Base") return "active-record";
    // `Sequel::Model` or `Sequel::Model(:table)` (the optional table arg is the
    // schema table name; we accept either form). The argument list may even span
    // lines, so allow `Sequel::Model` followed by an opening paren anywhere.
    if (s === "Sequel::Model" || /^Sequel::Model\s*\(/.test(s)) return "sequel";
    return null;
  }

  /**
   * Extract the bare class name a superclass refers to, for STI matching.
   * `User` → `User`; `Authors::Person` → `Person`; `Sequel::Model(:users)` →
   * null (handled by `ormForBase`). Returns null for ORM-base names.
   */
  private bareSuperclassName(superclass: string | null): string | null {
    if (!superclass) return null;
    const s = superclass.trim();
    // ORM bases are handled separately — never treat them as STI parents.
    if (s === "ApplicationRecord" || s === "ActiveRecord::Base") return null;
    if (/^Sequel::Model\b/.test(s)) return null;
    // A plain (possibly namespaced) constant reference, no call args.
    const m = /^([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*$/.exec(s);
    if (!m) return null;
    const segments = m[1]!.split("::");
    return segments[segments.length - 1] ?? null;
  }

  // ─── Association parsing ────────────────────────────────────────────────────

  /** Parse one association-macro statement into an EntityRelation, or null. */
  private parseAssociation(
    fromEntity: string,
    rawStatement: string,
    orm: string,
  ): EntityRelation | null {
    // The logical statement may contain embedded newlines from continuation
    // lines; flatten to a single line for the macro/symbol head match.
    const line = rawStatement.replace(/\s+/g, " ").trim();

    // macro :symbol , ...options. Explicitly anchored to the known association
    // macros so `validates`, `scope`, `enum`, `attr_accessor`, … never match.
    const m = /^([a-z_]+)\s+:([A-Za-z_][A-Za-z0-9_]*)\b(.*)$/.exec(line);
    if (!m) return null;

    const macro = m[1]!;
    const symbol = m[2]!;
    const rest = m[3] ?? "";

    if (!RubyEntityExtractor.ASSOCIATION_MACROS.has(macro)) return null;

    const cardinality = this.cardinalityFor(macro);
    if (!cardinality) return null;

    const isBelongsTo = macro === "belongs_to" || macro === "many_to_one";

    // Strip lambda scope blocks (`-> { ... }` / `lambda { ... }`) so option
    // parsing isn't confused by commas/colons/quotes inside the scope body.
    const optsTail = this.stripLambdaScopes(rest);

    // ── Options ────────────────────────────────────────────────────────────
    const className = this.optionValue(optsTail, "class_name");
    const explicitFk = this.optionValue(optsTail, "foreign_key");
    const throughTable = this.optionValue(optsTail, "through");
    const inverseOf = this.optionValue(optsTail, "inverse_of");
    const asName = this.optionValue(optsTail, "as");
    const isPolymorphic = this.boolOption(optsTail, "polymorphic");
    const optionalFlag = this.boolOption(optsTail, "optional");

    let cardinalityFinal = cardinality;
    let toEntity: string;
    let confidence: EntityRelation["confidence"];
    let joinTable: string | null = null;

    if (isPolymorphic || asName) {
      // Polymorphic relation: the concrete target is unknown at file scope. Use
      // the association name as a placeholder and flag it as a heuristic guess —
      // the project-level linker resolves the real target(s) later.
      //   belongs_to :commentable, polymorphic: true  → toEntity from :commentable
      //   has_many   :comments, as: :commentable       → toEntity from :comments
      toEntity = className
        ? this.bareClassName(className)
        : this.entityNameFromSymbol(symbol);
      confidence = "INFERRED";
    } else if (throughTable) {
      // has_many :tags, through: :taggings  → many-to-many via the join model.
      // We surface the *join* table (Tagging) and keep the relation as the
      // final target so the linker can resolve both hops.
      cardinalityFinal = "many-to-many";
      joinTable = this.capitalize(this.singularize(this.bareClassName(throughTable)));
      toEntity = className ? this.bareClassName(className) : this.entityNameFromSymbol(symbol);
      // Target name is convention-derived unless class_name was explicit.
      confidence = className ? "EXTRACTED" : "INFERRED";
    } else if (className) {
      // Explicit target — most reliable.
      toEntity = this.bareClassName(className);
      confidence = "EXTRACTED";
    } else {
      // Convention-derived target via singularization. Mark AMBIGUOUS when the
      // singularizer had to guess (irregular / non-standard plurals), otherwise
      // INFERRED for the well-understood regular cases.
      const { name, reliable } = this.entityNameFromSymbolDetailed(symbol);
      toEntity = name;
      confidence = reliable ? "INFERRED" : "AMBIGUOUS";
    }

    const relation: EntityRelation = {
      fromEntity,
      fromField: symbol,
      toEntity,
      cardinality: cardinalityFinal,
      orm,
      confidence,
    };

    // Join/through table for many-to-many.
    if (joinTable) relation.joinTable = joinTable;

    // Inverse field, when declared on either side.
    if (inverseOf) relation.inverseField = inverseOf;

    // Optional flag (nullable FK). `optional: true` makes it nullable; an
    // explicit `optional: false` pins it required. By Rails 5+ default a
    // belongs_to is required, so only record what's explicitly declared.
    if (optionalFlag !== null) relation.optional = optionalFlag;

    // Foreign key is meaningful on the owning (many-to-one) side.
    if (explicitFk) {
      relation.foreignKey = explicitFk;
    } else if (isBelongsTo && !isPolymorphic) {
      relation.foreignKey = `${this.singularize(symbol)}_id`;
    }

    return relation;
  }

  private cardinalityFor(macro: string): EntityRelation["cardinality"] | null {
    switch (macro) {
      case "has_many":
      case "one_to_many":
        return "one-to-many";
      case "belongs_to":
      case "many_to_one":
        return "many-to-one";
      case "has_one":
      case "one_to_one":
        return "one-to-one";
      case "has_and_belongs_to_many":
      case "many_to_many":
        return "many-to-many";
      default:
        return null;
    }
  }

  // ─── Option-value parsing ──────────────────────────────────────────────────

  /**
   * Read an option's *value* from the macro tail. Handles every realistic
   * spelling Rails/Sequel use:
   *   key: "Value"  | key: 'Value'   → quoted string
   *   key: :Symbol                   → symbol (leading colon stripped)
   *   key: Article                   → bare constant reference
   *   key: Authors::Person           → namespaced constant
   * Returns the raw value string (quotes/colon removed) or null.
   *
   * When the key appears more than once (e.g. a stray match inside a residual
   * scope), the *last* occurrence wins, since options always follow the scope.
   */
  private optionValue(rest: string, key: string): string | null {
    // Match BOTH `key: value` (1.9+ syntax) and `:key => value` (hash-rocket,
    // ubiquitous in older Rails codebases like this app's `:through => :x`).
    const re = new RegExp(
      `(?:\\b${key}\\s*:|:${key}\\s*=>)\\s*(?:` +
        `"([^"]*)"` + // 1: double-quoted
        `|'([^']*)'` + // 2: single-quoted
        `|:([A-Za-z_][A-Za-z0-9_]*)` + // 3: :symbol
        `|([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)` + // 4: bare/namespaced const
        `)`,
      "g",
    );
    let match: RegExpExecArray | null;
    let value: string | null = null;
    while ((match = re.exec(rest)) !== null) {
      const candidate = match[1] ?? match[2] ?? match[3] ?? match[4] ?? null;
      if (candidate === null) continue;
      // Guard against capturing reserved bare words that are never class/FK
      // references (true/false/nil) via group 4.
      if (match[4] && /^(true|false|nil)$/.test(match[4])) continue;
      value = candidate;
    }
    return value;
  }

  /**
   * Read a boolean-ish option (`polymorphic: true`, `optional: false`). Returns
   * true/false when the bare word `true`/`false` follows the key, else null
   * (option absent).
   */
  private boolOption(rest: string, key: string): boolean | null {
    // Both `key: true` and hash-rocket `:key => true`.
    const re = new RegExp(`(?:\\b${key}\\s*:|:${key}\\s*=>)\\s*(true|false)\\b`);
    const m = re.exec(rest);
    if (!m) return null;
    return m[1] === "true";
  }

  /**
   * Remove lambda scope blocks from a macro tail so option parsing isn't thrown
   * off by their internal commas/colons/quotes. Handles both `-> { ... }` and
   * `lambda { ... }` / `proc { ... }`, using string-aware brace matching.
   */
  private stripLambdaScopes(rest: string): string {
    let s = rest;
    const lambdaHead = /->\s*(\([^)]*\)\s*)?\{|(?:\blambda\b|\bproc\b)\s*\{/;
    for (let guard = 0; guard < 8; guard++) {
      const m = lambdaHead.exec(s);
      if (!m) break;
      const braceIdx = s.indexOf("{", m.index);
      if (braceIdx < 0) break;
      const close = this.matchBracket(s, braceIdx);
      if (close < 0) {
        // Unbalanced — drop everything from the lambda head onward to be safe.
        s = s.slice(0, m.index);
        break;
      }
      s = s.slice(0, m.index) + s.slice(close + 1);
    }
    return s;
  }

  // ─── Name inference ─────────────────────────────────────────────────────────

  /** Bare entity name for a class reference value (`Authors::Person` → Person). */
  private bareClassName(ref: string): string {
    const segments = ref.split("::");
    const last = segments[segments.length - 1] ?? ref;
    return this.capitalize(last);
  }

  /** Convention entity name from an association symbol (e.g. `comments` → Comment). */
  private entityNameFromSymbol(symbol: string): string {
    return this.entityNameFromSymbolDetailed(symbol).name;
  }

  /**
   * Convention entity name plus a reliability flag. `reliable` is false when the
   * plural form is ambiguous for our singularizer (so callers can downgrade the
   * relation confidence to AMBIGUOUS).
   */
  private entityNameFromSymbolDetailed(symbol: string): { name: string; reliable: boolean } {
    const { singular, reliable } = this.singularizeDetailed(symbol);
    return { name: this.capitalize(singular), reliable };
  }

  /**
   * Singularize a (snake_case) association name. Delegates to the detailed form
   * and returns just the word.
   */
  private singularize(word: string): string {
    return this.singularizeDetailed(word).singular;
  }

  /** Irregular plural → singular table (extend as real corpora demand). */
  private static readonly IRREGULAR_PLURALS: Record<string, string> = {
    people: "person",
    children: "child",
    men: "man",
    women: "woman",
    feet: "foot",
    teeth: "tooth",
    geese: "goose",
    mice: "mouse",
    oxen: "ox",
    indices: "index",
    matrices: "matrix",
    vertices: "vertex",
    data: "datum",
    media: "medium",
    criteria: "criterion",
    analyses: "analysis",
    // Single-`s` stems that take `-es` (the generic rule would drop only `s`).
    statuses: "status",
    buses: "bus",
    busses: "bus",
    gases: "gas",
    lenses: "lens",
    biases: "bias",
    quizzes: "quiz",
    // `-ches` whose singular keeps the trailing `e` (the sibilant rule would
    // wrongly drop `es`).
    caches: "cache",
    niches: "niche",
    headaches: "headache",
    mustaches: "mustache",
    avalanches: "avalanche",
  };

  /**
   * Singularize with a reliability hint.
   *   - irregular-table hits and clean regular rules → reliable
   *   - words ending `-ses`/`-es` that collide with our rules (axes, statuses,
   *     etc.) are handled conservatively and flagged unreliable when guessed.
   *
   * Operates only on the trailing word so namespaced/snake names work
   * (`blog_posts` → `blog_post`).
   */
  private singularizeDetailed(word: string): { singular: string; reliable: boolean } {
    const lower = word.toLowerCase();

    // Irregular plurals (whole-word match).
    const irregular = RubyEntityExtractor.IRREGULAR_PLURALS[lower];
    if (irregular) {
      // Preserve snake-case prefix if any (rare, but e.g. `team_people`).
      return { singular: this.replaceTrailingWord(word, irregular), reliable: true };
    }

    // `...ies` → `...y` (companies → company). Reliable.
    if (/ies$/i.test(word) && word.length > 3) {
      return { singular: word.replace(/ies$/i, "y"), reliable: true };
    }

    // Sibilant plurals whose singular has NO trailing `e`: a doubled `ss`, or
    // `x` / `zz` / `ch` / `sh`, followed by `es` → drop `es`
    // (classes → class, boxes → box, watches → watch, dishes → dish). The
    // single-`s` `-ses` case (case/course/phase) and `-che` keepers
    // (cache/niche) are intentionally NOT here — they fall through to the
    // drop-`s` rule or the irregular table.
    if (/(ss|x|zz|ch|sh)es$/i.test(word)) {
      return { singular: word.replace(/es$/i, ""), reliable: true };
    }

    // Regular plural: drop the trailing `s` (role → roles, case → cases,
    // course → courses, size → sizes, price → prices). Not for `...ss`
    // (address) or already-singular words. This is the common English plural
    // for nouns ending in a vowel/`e`, so treat it as reliable.
    if (/s$/i.test(word) && !/ss$/i.test(word)) {
      return { singular: word.replace(/s$/i, ""), reliable: true };
    }

    // Already singular (or a plural we don't model, e.g. `data` handled above).
    return { singular: word, reliable: true };
  }

  /** Replace the trailing snake-case word of `full` with `replacement`. */
  private replaceTrailingWord(full: string, replacement: string): string {
    const idx = full.lastIndexOf("_");
    if (idx < 0) return replacement;
    return full.slice(0, idx + 1) + replacement;
  }

  /** Capitalize the first character and camelize snake_case to PascalCase. */
  private capitalize(word: string): string {
    if (!word) return word;
    // `blog_post` → `BlogPost`; `Comment` → `Comment`.
    return word
      .split("_")
      .filter((p) => p.length > 0)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("");
  }
}

// ─── Association / instance chain resolution (project-level) ───────────────

/** `ContactInbox` → `contact_inbox`: the variable a Rails developer names after the model. */
function railsUnderscore(name: string): string {
  return name.replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

/**
 * The entity-less `database` rows the per-file pass emitted for chains
 * (`Current.account.conversations.find_by!`, `conversation.update!`) resolve
 * here, against every model the project declares:
 *   - the segment before the verb is an association ONE model declares (or
 *     several, all to the same target) → that target;
 *   - else it is a variable named like a declared model (`conversation`,
 *     `@contact_inbox`) → that model;
 *   - else the row is removed — a collection or a service object sharing the verb.
 * A project without models (plain Ruby) keeps nothing of these.
 */
function resolveChainAccesses(analyses: FileAnalysis[]): void {
  const ruby = analyses.filter((a) => a.language === "ruby");
  const models = new Map<string, string>(); // underscored → model name
  const associations = new Map<string, Set<string>>();
  for (const a of ruby) {
    for (const cls of a.classes) {
      if (!cls.decorators.includes("entity")) continue;
      const bare = cls.name.split("::").pop()!;
      models.set(railsUnderscore(bare), bare);
    }
    for (const rel of a.entityRelations ?? []) {
      const set = associations.get(rel.fromField) ?? new Set<string>();
      set.add(rel.toEntity.split("::").pop()!);
      associations.set(rel.fromField, set);
    }
  }
  for (const a of ruby) {
    let changed = false;
    const next: DataSourceInfo[] = [];
    for (const ds of a.dataSources) {
      // Every other Ruby `database` row names its entity already; the
      // entity-less dotted ones are the chain candidates.
      if (ds.kind !== "database" || ds.entity || !ds.name.includes(".")) {
        next.push(ds);
        continue;
      }
      const segments = ds.name.split(".");
      changed = true;
      if (models.size === 0) continue;
      const before = segments[segments.length - 2]!.replace(/\(\)$/, "").replace(/^(?:@{1,2}|\$)/, "");
      const targets = associations.get(before);
      const entity = targets && targets.size === 1 ? [...targets][0]! : models.get(before) ?? null;
      if (entity && [...models.values()].includes(entity)) next.push({ ...ds, entity });
    }
    if (changed) a.dataSources = next;
  }
}
