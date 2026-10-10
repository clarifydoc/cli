import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import { receiverTypeName } from "../../shared/type-parser.js";
import { RELATIVE_SCOPE_RE } from "./data-sources.js";
import type {
  ClassInfo,
  DataSourceInfo,
  EntityRelation,
  FileAnalysis,
  FunctionInfo,
  Language,
  PropertyInfo,
} from "../../../types/analysis.js";

/**
 * Extracts ORM entities + relations from PHP source for two ecosystems:
 *
 *   - Eloquent (Laravel): classes whose inheritance chain reaches an Eloquent
 *     base (`Model` / `Authenticatable` / `Pivot`, including fully-qualified
 *     `Illuminate\Database\Eloquent\Model`, and project-local subclasses such
 *     as `BaseModel extends Model`). Columns come from `$fillable` and the keys
 *     of `$casts`; relations come from `hasMany` / `belongsTo` / `hasOne` /
 *     `belongsToMany` / the `*Through` and polymorphic `morph*` methods.
 *
 *   - Doctrine ORM: classes annotated `#[ORM\Entity]` / `#[Entity]` /
 *     `@ORM\Entity` / `@Entity`, with columns from `Column` attributes and
 *     relations from `ManyToOne` / `OneToMany` / `OneToOne` / `ManyToMany`
 *     attributes (PHP 8 `#[...]` form *and* legacy docblock annotations).
 *
 * Source-text based (re-scans class bodies via the shared multiline-aware base
 * helpers); never throws — unparseable members are skipped. Entities are
 * emitted with the SAME name as the existing ClassInfo so the merge step
 * enriches them; related entity names go into `implementsList`.
 */
export class PhpEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["php"];

  /**
   * Comment prefixes safe to use when scanning PHP 8 attributes. We deliberately
   * exclude `#` here: an attribute starts with `#[`, so a `#`-aware stripper
   * would erase the whole attribute line. A lone `# ...` comment that survives
   * is harmless — it matches neither a decorator nor a property declaration.
   */
  private static readonly ATTR_SAFE_COMMENTS = ["//"] as const;

  /** Eloquent base classes that mark a class (and its descendants) as a model. */
  private static readonly ELOQUENT_BASES = new Set(["Model", "Authenticatable", "Pivot"]);

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    // Resolve which classes are Eloquent models up front so a local subclass of
    // a model (`BaseModel extends Model`) is recognised even when it appears
    // after its parent in the file — this needs the whole class set.
    const eloquentNames = this.resolveEloquentClasses(ctx);

    for (const cls of ctx.analysis.classes) {
      try {
        const body = this.bodyOf(ctx, cls);
        if (eloquentNames.has(cls.name)) {
          this.extractEloquent(cls, body, entities, relations);
        } else if (this.isDoctrineEntity(ctx, cls)) {
          this.extractDoctrine(cls, body, entities, relations);
        }
      } catch {
        // Never throw — skip a class we cannot parse.
      }
    }

    try {
      this.extractQueryBuilderJoins(ctx, relations);
    } catch {
      // Best-effort — join parsing never blocks entity extraction.
    }

    return { entities, relations };
  }

  // ─── CodeIgniter / query-builder JOIN relationships ───────────────────────

  /**
   * Derive table relationships from `->join('table', 'a.x = b.y')` calls. The
   * ON condition names BOTH tables and the join column, so a single call yields
   * a complete relation — and for CodeIgniter (tables are bare strings, no FK
   * metadata) joins are the ONLY relationship signal. Emitted with orm
   * `"ci-query"` so the entity-graph synthesis — which owns the inferred table
   * nodes those relations connect — builds the edges. Deduped per (pair, FK).
   */
  private extractQueryBuilderJoins(ctx: EntityExtractContext, relations: EntityRelation[]): void {
    const text = ctx.sourceText;
    const seen = new Set<string>();
    const re = /->\s*join\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const openIdx = text.indexOf("(", m.index + m[0].length - 1);
      if (openIdx < 0) continue;
      const close = this.matchBracket(text, openIdx);
      const argsText = close >= 0 ? text.slice(openIdx + 1, close) : "";
      const args = this.splitTopLevelArgs(argsText);
      if (args.length < 2) continue;

      const joined = this.cleanTableRef(this.firstStringLiteral(args[0]));
      const cond = this.firstStringLiteral(args[1]);
      if (!joined || !cond) continue;

      const rel = this.parseJoinCondition(cond, joined);
      if (!rel) continue;

      const key = `${rel.from.toLowerCase()}|${rel.to.toLowerCase()}|${rel.fk ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      relations.push({
        fromEntity: rel.from,
        fromField: rel.fk ?? rel.to.toLowerCase(),
        toEntity: rel.to,
        cardinality: "many-to-one",
        foreignKey: rel.fk,
        orm: "ci-query",
        confidence: "INFERRED",
      });
    }
  }

  /** A bare table name from a join's first arg: drops an alias and schema/quotes. */
  private cleanTableRef(raw: string | null): string | null {
    if (!raw) return null;
    let t = (raw.trim().split(/\s+/)[0] ?? "").split(".").pop() ?? "";
    t = t.replace(/`/g, "");
    return /^[A-Za-z_]\w*$/.test(t) ? t : null;
  }

  /**
   * Parse a join ON condition (`orders.customer_id = customers.customer_id`)
   * into a `many → one` relation between its two `table.column` operands.
   *
   * Direction comes from the foreign-key COLUMN, not from which side was joined
   * (joining a lookup/master table is just as common as joining a detail): a
   * `customer_id` column references the `customers` table, so the table whose
   * (singularized) name matches the column's `_id` prefix is the referenced
   * `to` (one) side and the other table owns the FK and is the `from` (many)
   * side. Falls back to treating the just-joined table as the referenced side
   * when no prefix matches. Returns null for non-`t.c = t.c` conditions.
   */
  private parseJoinCondition(
    cond: string,
    joined: string,
  ): { from: string; to: string; fk: string | null } | null {
    const m = cond.match(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/);
    if (!m) return null;
    const [, t1, c1, t2, c2] = m;
    if (t1.toLowerCase() === t2.toLowerCase()) return null; // self-join — skip noise

    // The FK column is a non-`id` `<entity>_id`; prefer it over a bare `id`/PK.
    const isFk = (c: string) => /_id$/i.test(c) && c.toLowerCase() !== "id";
    const fk = isFk(c1) ? c1 : isFk(c2) ? c2 : c1;
    const prefix = fk.replace(/_id$/i, "").toLowerCase(); // customer_id → "customer"
    const sing = (t: string) => t.toLowerCase().replace(/s$/, "");
    const refsPrefix = (t: string) => sing(t) === prefix || t.toLowerCase() === prefix;

    // Referenced (one) table = the one the FK prefix names; the other owns the FK.
    if (refsPrefix(t1) && !refsPrefix(t2)) return { from: t2, to: t1, fk };
    if (refsPrefix(t2) && !refsPrefix(t1)) return { from: t1, to: t2, fk };
    // Ambiguous prefix — the freshly-joined table is usually the looked-up (one) side.
    const jl = joined.toLowerCase();
    if (t1.toLowerCase() === jl) return { from: t2, to: t1, fk };
    return { from: t1, to: t2, fk };
  }

  /**
   * Project-level pass: which Eloquent accesses touch which model.
   *
   * Per file, `Account::where(…)->first()` is a query on `Account` only if
   * `Account` is a model — `Carbon::create(…)` and `Finder::create()` share the
   * verb and were two thirds of firefly-iii's and koel's "database" rows. And
   * `$user->accounts()->where(…)->get()` names its table only through the
   * relation `accounts()`, declared on `User` in another file. Both joins need
   * every model the project declares, so they happen here:
   *   - a static root that is a declared model → that model (`static::`/`self::`
   *     inside a model class → the class);
   *   - the LAST `->relation()` segment whose name every declaring model maps
   *     to one target → that target;
   *   - `$this->prop->…` through a property or promoted constructor parameter
   *     typed as a model, `$var->…` through a typed parameter or local;
   *   - a chain on `$this`, `$query` or `$builder` inside a model's own method
   *     (scopes, accessors) → that model.
   * A row that resolves gets `entity` (what `attributeDataAccessToSymbols`
   * keys on) and `target`. One that does not, in a project that DOES declare
   * models, was never an Eloquent access and is removed — a facade or value
   * object sharing the verb. PDO (`$pdo->query(…)`, `$stmt->fetchAll()`),
   * CodeIgniter (`$this->db->…`) and the `DB`/`Schema` facades are left as
   * they are: their table is the SQL text or the argument, not a model.
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const php = analyses.filter((a) => a.language === "php");
    const models = new Set<string>();
    const relationTargets = new Map<string, Set<string>>();
    for (const a of php) {
      for (const cls of a.classes) {
        if (cls.decorators.includes("entity") && cls.decorators.includes("eloquent")) models.add(cls.name);
      }
      for (const rel of a.entityRelations ?? []) {
        if (rel.orm !== "eloquent") continue;
        const set = relationTargets.get(rel.fromField) ?? new Set<string>();
        set.add(rel.toEntity);
        relationTargets.set(rel.fromField, set);
      }
    }
    if (models.size === 0) return;
    const relationEntity = (field: string): string | null => {
      const set = relationTargets.get(field);
      return set && set.size === 1 ? [...set][0]! : null;
    };

    for (const a of php) {
      let changed = false;
      const next: DataSourceInfo[] = [];
      for (const ds of a.dataSources) {
        if (ds.kind !== "database" || ds.entity || !isEloquentCandidate(ds.name)) {
          next.push(ds);
          continue;
        }
        const entity = resolveEloquentEntity(ds, a, models, relationEntity);
        changed = true;
        if (entity) next.push({ ...ds, entity, target: entity });
        // else: dropped — a verb-sharing non-model call.
      }
      if (changed) a.dataSources = next;
    }
  }

  // ─── Eloquent detection (inheritance chain) ───────────────────────────────

  /**
   * Build the set of class names that are Eloquent models, following the
   * `extends` chain across all classes declared in this file. A class is a
   * model when it (transitively) extends a known Eloquent base, OR when it
   * extends a fully-qualified Eloquent `Model`, OR — as a convention fallback —
   * when it carries unmistakable Eloquent markers (`$fillable` / `$guarded` /
   * `$casts` / `$table` together with at least one relation method).
   */
  private resolveEloquentClasses(ctx: EntityExtractContext): Set<string> {
    const classes = ctx.analysis.classes;
    const byName = new Map<string, ClassInfo>();
    for (const c of classes) byName.set(c.name, c);

    const isEloquent = new Map<string, boolean>();

    const resolve = (cls: ClassInfo, seen: Set<string>): boolean => {
      const cached = isEloquent.get(cls.name);
      if (cached !== undefined) return cached;
      if (seen.has(cls.name)) return false; // cycle guard
      seen.add(cls.name);

      let result = false;
      const base = this.shortName(cls.extends);
      if (base && PhpEntityExtractor.ELOQUENT_BASES.has(base)) {
        result = true;
      } else if (base && this.isFqEloquentModel(cls.extends)) {
        result = true;
      } else if (base && byName.has(base)) {
        // Local subclass — walk up the chain to its declared parent.
        result = resolve(byName.get(base)!, seen);
      }

      isEloquent.set(cls.name, result);
      return result;
    };

    const out = new Set<string>();
    for (const cls of classes) {
      if (resolve(cls, new Set())) {
        out.add(cls.name);
      } else if (this.hasEloquentMarkers(ctx, cls)) {
        // Convention fallback for models extending an out-of-file base we can't
        // see (e.g. a vendor/package model) but that clearly behave like one.
        out.add(cls.name);
      }
    }
    return out;
  }

  /** True for a fully-qualified Eloquent `...\Eloquent\Model` reference. */
  private isFqEloquentModel(ref: string | null): boolean {
    if (!ref) return false;
    return /Illuminate\\Database\\Eloquent\\(Model|Pivot)\b/.test(ref) ||
      /\bEloquent\\Model\b/.test(ref);
  }

  /**
   * Heuristic: a class that declares Eloquent's signature properties AND at
   * least one relation method is almost certainly a model even if its base
   * class lives outside this file. Kept strict to avoid false positives.
   */
  private hasEloquentMarkers(ctx: EntityExtractContext, cls: ClassInfo): boolean {
    if (!cls.extends) return false; // a model always extends *something*
    const body = this.bodyOf(ctx, cls).join("\n");
    const hasProp = /\$(fillable|guarded|casts|table)\b/.test(body);
    const hasRel = /\$this->(hasMany|hasOne|belongsTo|belongsToMany|morph\w+|hasManyThrough|hasOneThrough)\s*\(/
      .test(body);
    return hasProp && hasRel;
  }

  // ─── Eloquent extraction ───────────────────────────────────────────────────

  /** Eloquent relation methods → cardinality + provenance. */
  private static readonly ELOQUENT_RELATIONS: Array<{
    marker: string;
    cardinality: EntityRelation["cardinality"];
    confidence: NonNullable<EntityRelation["confidence"]>;
  }> = [
    // Matched by exact method name, so order is irrelevant. `morph*` and
    // `*Through` relations have no explicit FK/join declaration here, so they
    // are INFERRED; the directly-typed relations are EXTRACTED.
    { marker: "hasManyThrough", cardinality: "one-to-many", confidence: "EXTRACTED" },
    { marker: "hasOneThrough", cardinality: "one-to-one", confidence: "EXTRACTED" },
    { marker: "belongsToMany", cardinality: "many-to-many", confidence: "EXTRACTED" },
    { marker: "morphToMany", cardinality: "many-to-many", confidence: "INFERRED" },
    { marker: "morphedByMany", cardinality: "many-to-many", confidence: "INFERRED" },
    { marker: "morphMany", cardinality: "one-to-many", confidence: "INFERRED" },
    { marker: "morphOne", cardinality: "one-to-one", confidence: "INFERRED" },
    { marker: "morphTo", cardinality: "many-to-one", confidence: "INFERRED" },
    { marker: "hasMany", cardinality: "one-to-many", confidence: "EXTRACTED" },
    { marker: "hasOne", cardinality: "one-to-one", confidence: "EXTRACTED" },
    { marker: "belongsTo", cardinality: "many-to-one", confidence: "EXTRACTED" },
  ];

  private extractEloquent(
    cls: ClassInfo,
    body: string[],
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    const properties: PropertyInfo[] = [];
    const seenCols = new Set<string>();

    const addCol = (name: string, type: string | null = null): void => {
      const clean = this.stripDollar(name);
      if (!clean || seenCols.has(clean)) return;
      seenCols.add(clean);
      properties.push(this.column(clean, type));
    };

    const text = body.join("\n");

    // protected $fillable = ['name', 'email', ...];  (array may span lines)
    for (const arr of this.extractArrayAssignments(text, "fillable")) {
      for (const item of this.extractStringLiterals(arr)) addCol(item);
    }
    // protected $casts = ['published_at' => 'datetime', ...]; → keys become
    // columns, value (quoted or not) becomes the column type when present.
    for (const arr of this.extractArrayAssignments(text, "casts")) {
      for (const [key, castType] of this.extractArrayPairs(arr)) addCol(key, castType);
    }

    const fromEntity = cls.name;
    const targets = new Set<string>();

    // Relations: scan the whole body for every `$this-><relation>(...)` call.
    // We slice each call's *balanced* argument list (string-aware, multiline-
    // safe — covers arrow-fn bodies and args spread over several lines) and
    // derive the relation field from the nearest enclosing `function` name.
    // Scanning the full text (rather than per-logical-line) is necessary
    // because the class's own `{ ... }` keeps a logical statement open across
    // every method, so per-statement collapsing would merge them all.
    const seenRel = new Set<string>();
    for (const call of this.findRelationCalls(text)) {
      const rel = this.classifyRelationCall(call);
      if (!rel || !rel.target) continue;

      const field = this.enclosingFunctionName(text, call.index) ?? rel.target.toLowerCase();
      const dedupeKey = `${field}|${rel.target}|${rel.cardinality}`;
      if (seenRel.has(dedupeKey)) continue;
      seenRel.add(dedupeKey);

      relations.push({
        fromEntity,
        fromField: field,
        toEntity: rel.target,
        cardinality: rel.cardinality,
        joinTable: rel.joinTable ?? undefined,
        orm: "eloquent",
        confidence: rel.confidence,
      });
      targets.add(rel.target);
    }

    entities.push(
      this.entity({
        name: cls.name,
        orm: "eloquent",
        properties,
        implementsList: [...targets],
        extends: cls.extends,
        line: cls.line,
        endLine: cls.endLine,
      }),
    );
  }

  /**
   * Locate every `$this-><relation>(...)` Eloquent call in the body text. For
   * each, slice the call's balanced (string-aware, multiline) argument list and
   * record the marker, the call's start index, and the parsed top-level args.
   * On an unclosed `(` we recover the remainder rather than dropping the call.
   */
  private findRelationCalls(text: string): Array<{
    marker: string;
    index: number;
    args: string[];
  }> {
    const calls: Array<{ marker: string; index: number; args: string[] }> = [];
    // Find every `$this-> <method> (` then classify the method name; this scans
    // once regardless of how many relation kinds we support.
    const callRe = /\$this\s*->\s*(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(text)) !== null) {
      const marker = m[1];
      // Only relation methods are of interest.
      if (!PhpEntityExtractor.ELOQUENT_RELATIONS.some((r) => r.marker === marker)) continue;
      const openIdx = text.indexOf("(", m.index + m[0].length - 1);
      if (openIdx < 0) continue;
      const close = this.matchBracket(text, openIdx);
      const argsText = close >= 0 ? text.slice(openIdx + 1, close) : text.slice(openIdx + 1);
      calls.push({ marker, index: m.index, args: this.splitTopLevelArgs(argsText) });
    }
    return calls;
  }

  /**
   * Classify a relation call into its target entity, cardinality, provenance,
   * and (for belongsToMany / morph*ToMany) the named pivot/join table.
   */
  private classifyRelationCall(call: { marker: string; args: string[] }):
    | {
        cardinality: EntityRelation["cardinality"];
        target: string | null;
        joinTable: string | null;
        confidence: NonNullable<EntityRelation["confidence"]>;
      }
    | null {
    const kind = PhpEntityExtractor.ELOQUENT_RELATIONS.find((r) => r.marker === call.marker);
    if (!kind) return null;

    const target = call.args.length > 0 ? this.resolveClassRef(call.args[0]) : null;

    // belongsToMany(Related::class, 'pivot_table') — 2nd arg is the join table
    // when it's a string literal (not a column name / ::class reference).
    let joinTable: string | null = null;
    if (call.marker === "belongsToMany" || call.marker === "morphToMany" || call.marker === "morphedByMany") {
      if (call.args.length >= 2 && !/::class\b/.test(call.args[1])) {
        joinTable = this.firstStringLiteral(call.args[1]);
      }
    }

    return { cardinality: kind.cardinality, target, joinTable, confidence: kind.confidence };
  }

  /** Name of the `function <name>(` whose body most closely precedes `idx`. */
  private enclosingFunctionName(text: string, idx: number): string | null {
    const before = text.slice(0, idx);
    let last: string | null = null;
    const re = /\bfunction\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(before)) !== null) last = m[1];
    return last;
  }

  // ─── Doctrine detection ─────────────────────────────────────────────────────

  private isDoctrineEntity(ctx: EntityExtractContext, cls: ClassInfo): boolean {
    // Attribute on the class is captured in decorators if the extractor saw it.
    for (const dec of cls.decorators) {
      if (/ORM\\?Entity\b/.test(dec) || /^\s*#?\[?\s*Entity\b/.test(dec)) return true;
    }
    // Scan the full preamble between the *previous* declaration and this class
    // (no fixed look-back window) so a long docblock can't hide `@ORM\Entity`.
    const classIdx = Math.max(0, cls.line - 1);
    let start = 0;
    for (const other of ctx.analysis.classes) {
      const otherEnd = other.endLine ?? other.line;
      if (otherEnd < cls.line && otherEnd > start) start = otherEnd;
    }
    const preamble = ctx.lines.slice(start, classIdx).join("\n");
    return /#\[\s*(?:ORM\\)?Entity\b/.test(preamble) ||
      /@ORM\\Entity\b/.test(preamble) ||
      /@Entity\b/.test(preamble);
  }

  /**
   * Return the lines strictly inside a class body — i.e. those between the
   * opening `{` of the class declaration and its matching `}`. The class header
   * may put the `{` on a later line, so we locate the first top-level `{` by
   * bracket depth and the matching close by running depth back to zero. Falls
   * back to the full body (minus the first line) if braces can't be balanced,
   * so member extraction still runs rather than silently producing nothing.
   */
  private innerBody(body: string[]): string[] {
    let openLine = -1;
    let depth = 0;
    // Find the line that first raises brace depth above zero (the class `{`).
    for (let i = 0; i < body.length; i++) {
      depth += this.braceDelta(body[i] ?? "");
      if (depth >= 1) { openLine = i; break; }
    }
    if (openLine < 0) return body.slice(1);

    // From the open line, walk forward to the matching close.
    depth = 0;
    for (let i = openLine; i < body.length; i++) {
      depth += this.braceDelta(body[i] ?? "");
      if (i > openLine && depth <= 0) {
        return body.slice(openLine + 1, i);
      }
    }
    // Unbalanced (e.g. truncated body) — return everything after the open line.
    return body.slice(openLine + 1);
  }

  /** Net `{`/`}` depth change on a line, ignoring braces in string literals. */
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

  // ─── Doctrine extraction ────────────────────────────────────────────────────

  /** Doctrine relation attribute name → cardinality. */
  private static readonly DOCTRINE_RELATIONS: Array<{
    marker: string;
    cardinality: EntityRelation["cardinality"];
  }> = [
    { marker: "ManyToOne", cardinality: "many-to-one" },
    { marker: "OneToMany", cardinality: "one-to-many" },
    { marker: "ManyToMany", cardinality: "many-to-many" },
    { marker: "OneToOne", cardinality: "one-to-one" },
  ];

  private extractDoctrine(
    cls: ClassInfo,
    body: string[],
    entities: ClassInfo[],
    relations: EntityRelation[],
  ): void {
    const properties: PropertyInfo[] = [];
    const seenCols = new Set<string>();
    const fromEntity = cls.name;
    const targets = new Set<string>();

    // Work on the *inner* body (lines strictly between the class's `{` and its
    // matching `}`). The wrapping braces would otherwise keep every member in a
    // single unbalanced logical statement and defeat `decoratedMembers`.
    const inner = this.innerBody(body);

    // `decoratedMembers` groups stacked / inline / multiline `#[...]` attributes
    // with the member they precede, so an attribute on the SAME line as the
    // property (`#[Column(...)] private string $name;`) is handled correctly.
    // NOTE: we must NOT pass `#` as a comment prefix here — a PHP 8 attribute
    // begins with `#[`, and the comment stripper would otherwise delete the
    // whole attribute line. `//` line comments are still stripped.
    const members = this.decoratedMembers(inner, {
      style: "hash-square",
      lineComment: PhpEntityExtractor.ATTR_SAFE_COMMENTS,
    });

    // Legacy docblock annotations (`@ORM\Column`, `@ORM\ManyToOne(...)`) are not
    // `#[...]` attributes, so capture them from the raw lines too and associate
    // them with the next property declaration.
    const docblockByProp = this.collectDocblockAnnotations(inner);

    for (const member of members) {
      const decl = member.declaration;
      const prop = this.matchPropertyDecl(decl);
      if (!prop) continue;
      const name = this.stripDollar(prop.name);
      if (!name) continue;

      // Combine #[...] attributes with any docblock annotations for this field.
      const attrText = member.decorators.join("\n");
      const docText = docblockByProp.get(name) ?? "";
      const ann = attrText + "\n" + docText;

      const rel = this.matchDoctrineRelation(ann);
      if (rel && rel.target) {
        relations.push({
          fromEntity,
          fromField: name,
          toEntity: rel.target,
          cardinality: rel.cardinality,
          foreignKey: this.matchJoinColumn(ann),
          inverseField: rel.mappedBy,
          joinTable: rel.joinTable ?? undefined,
          orm: "doctrine",
          confidence: "EXTRACTED",
        });
        targets.add(rel.target);
        continue;
      }

      // Only emit scalar/value columns as properties — never as relations.
      const isColumn = /#?\[?\s*(?:ORM\\)?Column\b/.test(attrText) ||
        /@(?:ORM\\)?Column\b/.test(docText) || /@var\b/.test(docText);
      if (isColumn && !seenCols.has(name)) {
        seenCols.add(name);
        properties.push(this.column(name, this.coreType(prop.type) ?? prop.type));
      }
    }

    entities.push(
      this.entity({
        name: cls.name,
        orm: "doctrine",
        properties,
        implementsList: [...targets],
        extends: cls.extends,
        line: cls.line,
        endLine: cls.endLine,
      }),
    );
  }

  /**
   * Map each property name to its preceding docblock text (`/** ... *​/`). Used
   * for the legacy annotation style where ORM metadata lives in a comment.
   */
  private collectDocblockAnnotations(body: string[]): Map<string, string> {
    const out = new Map<string, string>();
    let docBuf = "";
    let inDoc = false;
    for (const raw of body) {
      const line = raw.trim();
      if (line.startsWith("/**") || line.startsWith("/*")) {
        inDoc = true;
        docBuf = line;
        if (line.includes("*/")) inDoc = false;
        continue;
      }
      if (inDoc) {
        docBuf += "\n" + line;
        if (line.includes("*/")) inDoc = false;
        continue;
      }
      const prop = this.matchPropertyDecl(line);
      if (prop) {
        const name = this.stripDollar(prop.name);
        if (name && docBuf) out.set(name, docBuf);
        docBuf = "";
      } else if (line.length > 0 && !line.startsWith("#[") && !line.startsWith("//") && !line.startsWith("#")) {
        // A non-comment, non-attribute, non-property line ends the docblock's scope.
        docBuf = "";
      }
    }
    return out;
  }

  // ─── Doctrine helpers ───────────────────────────────────────────────────────

  /** Match `private string $name;` / `public ?int $id = 0;` / `protected $x;`. */
  private matchPropertyDecl(line: string): { name: string; type: string | null } | null {
    const m = line.match(
      /\b(?:public|private|protected)\s+(?:readonly\s+)?(?:static\s+)?(?:(\?[\\\w|]+|[\\\w|]+)\s+)?\$(\w+)/,
    );
    if (!m) return null;
    const type = m[1] ? m[1].replace(/^\?/, "") : null;
    return { name: m[2], type };
  }

  private matchDoctrineRelation(ann: string): {
    cardinality: EntityRelation["cardinality"];
    target: string | null;
    mappedBy: string | null;
    joinTable: string | null;
  } | null {
    for (const { marker, cardinality } of PhpEntityExtractor.DOCTRINE_RELATIONS) {
      // Match #[ORM\ManyToOne(...)], #[ManyToOne(...)], @ORM\ManyToOne(...), @ManyToOne(...).
      const re = new RegExp(`(?:#\\[\\s*(?:ORM\\\\)?|@(?:ORM\\\\)?)${marker}\\b`);
      const m = re.exec(ann);
      if (!m) continue;

      // Slice the attribute's full balanced argument list (handles multiline).
      const argsText = this.sliceAttributeArgs(ann, m.index);
      return {
        cardinality,
        target: this.matchTargetEntity(argsText),
        mappedBy: this.matchMappedBy(argsText),
        joinTable: this.matchJoinTable(ann),
      };
    }
    return null;
  }

  /**
   * Given the annotation text and the start of a relation marker, return the
   * text inside the marker's `( ... )`. Falls back to the remainder of the
   * annotation when the parenthesis is unbalanced (no silent loss).
   */
  private sliceAttributeArgs(ann: string, markerIdx: number): string {
    const openIdx = ann.indexOf("(", markerIdx);
    if (openIdx < 0) return "";
    const close = this.matchBracket(ann, openIdx);
    return close >= 0 ? ann.slice(openIdx + 1, close) : ann.slice(openIdx + 1);
  }

  /**
   * Doctrine target entity: the named `targetEntity:` / `targetEntity=` arg,
   * OR the first positional argument (PHP 8 `#[ManyToOne(User::class)]`).
   */
  private matchTargetEntity(argsText: string): string | null {
    // Named form: targetEntity: User::class / targetEntity="User".
    const named = argsText.match(/targetEntity\s*[:=]\s*([\\\w]+::class|["'][^"']+["'])/);
    if (named) return this.resolveClassRef(named[1]);

    // Positional form: first argument is the target (when not a named arg).
    const args = this.splitTopLevelArgs(argsText);
    for (const arg of args) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      // Skip explicitly named arguments (`mappedBy: ...`, `cascade: [...]`).
      if (/^\w+\s*:/.test(trimmed) && !/::class/.test(trimmed.split(":")[0])) {
        // First token is `name:` — a named arg, not the positional target.
        if (!/::class|^["']/.test(trimmed)) continue;
      }
      const ref = this.resolveClassRef(trimmed);
      if (ref) return ref;
    }
    return null;
  }

  private matchMappedBy(argsText: string): string | null {
    const m = argsText.match(/mappedBy\s*[:=]\s*["']([^"']+)["']/);
    return m ? m[1] : null;
  }

  /**
   * `#[ORM\JoinColumn(name: "author_id")]` / `@ORM\JoinColumn(name="author_id")`.
   * Slices the JoinColumn's balanced args and finds `name` regardless of order
   * or of other (possibly bracketed) attributes around it.
   */
  private matchJoinColumn(ann: string): string | null {
    const re = /(?:#\[\s*(?:ORM\\)?|@(?:ORM\\)?)JoinColumn\b/;
    const m = re.exec(ann);
    if (!m) return null;
    const args = this.sliceAttributeArgs(ann, m.index);
    const name = args.match(/\bname\s*[:=]\s*["']([^"']+)["']/);
    return name ? name[1] : null;
  }

  /**
   * Doctrine `#[ORM\JoinTable(name: "users_roles")]` for ManyToMany relations.
   */
  private matchJoinTable(ann: string): string | null {
    const re = /(?:#\[\s*(?:ORM\\)?|@(?:ORM\\)?)JoinTable\b/;
    const m = re.exec(ann);
    if (!m) return null;
    const args = this.sliceAttributeArgs(ann, m.index);
    const name = args.match(/\bname\s*[:=]\s*["']([^"']+)["']/);
    return name ? name[1] : null;
  }

  // ─── Array / string parsing (escape & quote aware) ────────────────────────

  /**
   * Find array literals assigned to `$<prop> = [ ... ];` (any visibility /
   * spacing). Returns the raw inner text of each array (between the brackets),
   * using string-aware bracket matching so nested arrays and quoted brackets
   * are handled. On an unclosed bracket we return the partial remainder rather
   * than dropping the whole assignment silently.
   */
  private extractArrayAssignments(text: string, prop: string): string[] {
    const results: string[] = [];
    // Match up to and including the opening `[` so the bracket index is exact —
    // no separate indexOf that could drift on odd spacing.
    const re = new RegExp(`\\$${prop}\\s*=\\s*\\[`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const openIdx = m.index + m[0].length - 1; // position of the matched `[`
      const close = this.matchBracket(text, openIdx);
      if (close >= 0) {
        results.push(text.slice(openIdx + 1, close));
      } else {
        // Unclosed array — recover what we can (to end of text) instead of
        // silently discarding the whole `$fillable` / `$casts` definition.
        results.push(text.slice(openIdx + 1));
      }
    }
    return results;
  }

  /**
   * Pull every quoted string literal out of an array body, correctly handling
   * escaped quotes (`\'`, `\"`, `\\`) and a quote of one kind nested inside a
   * literal of the other kind.
   */
  private extractStringLiterals(arrBody: string): string[] {
    const out: string[] = [];
    for (const lit of this.scanStringLiterals(arrBody)) {
      if (lit.value.length > 0) out.push(lit.value);
    }
    return out;
  }

  /**
   * Pull `key => value` pairs from an array body. The key is a quoted string;
   * the value may be quoted (its content is used as the type) OR an unquoted
   * primitive such as `1`, `3.14`, `true`, `null`, or a `Type::class` /
   * enum-like token (the raw token text is used as the type). Keys with no
   * parseable value still yield `[key, null]` so the column is never lost.
   */
  private extractArrayPairs(arrBody: string): Array<[string, string | null]> {
    const out: Array<[string, string | null]> = [];
    // Tokenise into items split on top-level commas, then split each on `=>`.
    for (const item of this.splitTopLevelArgs(arrBody)) {
      const arrowIdx = this.findTopLevelArrow(item);
      if (arrowIdx < 0) {
        // A bare value in the array (not a pair) — used as a column name.
        const key = this.firstStringLiteral(item);
        if (key) out.push([key, null]);
        continue;
      }
      const keyPart = item.slice(0, arrowIdx);
      const valPart = item.slice(arrowIdx + 2).trim();
      const key = this.firstStringLiteral(keyPart);
      if (!key) continue;
      out.push([key, this.normalizeValue(valPart)]);
    }
    return out;
  }

  /** Normalise a cast value: quoted → its content; unquoted → trimmed token. */
  private normalizeValue(val: string): string | null {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const lit = this.firstStringLiteral(trimmed);
    if (lit !== null) return lit;
    // Unquoted primitive / class-ref — keep the bare token (e.g. `int`, `true`,
    // `3.14`, `Status::class`). Strip a trailing comment/garbage just in case.
    const token = trimmed.match(/^[\w\\.:]+(?:::class)?/);
    return token ? token[0] : null;
  }

  /** Index of a top-level `=>` (outside brackets/strings) in an array item, or -1. */
  private findTopLevelArrow(s: string): number {
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
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (depth === 0 && ch === "=" && s[i + 1] === ">") return i;
    }
    return -1;
  }

  /**
   * Split a comma-separated list on TOP-LEVEL commas only, ignoring commas
   * inside (), [], {} or string literals. Used for call arguments and array
   * items so nested structures stay intact.
   */
  private splitTopLevelArgs(s: string): string[] {
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
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (depth === 0 && ch === ",") {
        parts.push(s.slice(start, i));
        start = i + 1;
      }
    }
    const last = s.slice(start);
    if (last.trim() || parts.length > 0) parts.push(last);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
  }

  /**
   * Scan a string for PHP string literals, handling `\'`, `\"`, `\\` escapes
   * and allowing the opposite quote character to appear unescaped inside.
   * Returns each literal's decoded value (escapes for the active quote and `\\`
   * are unescaped; other backslash sequences are left intact).
   */
  private scanStringLiterals(s: string): Array<{ value: string }> {
    const out: Array<{ value: string }> = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let value = "";
        i++;
        while (i < s.length) {
          const c = s[i]!;
          if (c === "\\") {
            const next = s[i + 1];
            if (next === quote || next === "\\") {
              value += next; // unescape the quote / backslash
              i += 2;
              continue;
            }
            value += c; // keep other escape sequences verbatim
            i++;
            continue;
          }
          if (c === quote) { i++; break; }
          value += c;
          i++;
        }
        out.push({ value });
        continue;
      }
      i++;
    }
    return out;
  }

  /** First quoted string literal in `s` (escape-aware), or null. */
  private firstStringLiteral(s: string): string | null {
    const lits = this.scanStringLiterals(s);
    return lits.length > 0 ? lits[0].value : null;
  }

  // ─── Shared helpers ───────────────────────────────────────────────────────

  /** Strip a leading `$` from a PHP variable/property name. */
  private stripDollar(name: string): string {
    return name.replace(/^\$/, "").trim();
  }

  /**
   * Resolve a class reference argument to its short entity name. Accepts
   * `User::class`, `\App\Models\User::class`, quoted `"User"` / `'App\User'`,
   * or a bare identifier. Returns null for column names / scalar values.
   */
  private resolveClassRef(raw: string): string | null {
    const arg = raw.trim();
    const cls = arg.match(/([\\\w]+)::class/);
    if (cls) return this.shortName(cls[1]);
    const quoted = this.firstStringLiteral(arg);
    if (quoted) {
      // Treat a quoted FQCN-looking value as a class; a plain snake_case word
      // (a column / table name) is not an entity, so reject it.
      if (/[\\A-Z]/.test(quoted)) return this.shortName(quoted);
      return null;
    }
    return null;
  }

  /**
   * Resolve a PHP class reference to its short name: last backslash-separated
   * segment, with `::class` / quotes dropped.
   */
  private shortName(ref: string | null | undefined): string | null {
    if (!ref) return null;
    const s = ref.trim().replace(/["']/g, "").replace(/::class$/, "");
    const seg = s.split("\\").pop();
    return seg ? seg.trim() || null : null;
  }
}


// ─── Eloquent access resolution (project-level) ─────────────────────────────

/** CodeIgniter, PDO and Laravel's non-model facades keep their rows as emitted. */
const NON_ELOQUENT_ROW_RE =
  /^\$this\s*->\s*db\b|^(?:DB|Schema|Cache|Redis)::|^\$(?:pdo|db|dbh|conn|connection|stmt|statement|sth|mysqli|link)\b|->(?:query|exec|prepare|fetchAll|fetch)$/i;

function isEloquentCandidate(name: string): boolean {
  return !NON_ELOQUENT_ROW_RE.test(name);
}

/** Innermost class whose line range holds `line`, and the method inside it. */
function enclosing(a: FileAnalysis, line: number): { cls: ClassInfo | null; fn: FunctionInfo | null } {
  let cls: ClassInfo | null = null;
  for (const c of a.classes) {
    if (c.line <= line && line <= c.endLine && (!cls || c.line >= cls.line)) cls = c;
  }
  let fn: FunctionInfo | null = null;
  const pool = cls ? cls.methods : a.functions;
  for (const f of pool) {
    if (f.line <= line && line <= f.endLine && (!fn || f.line >= fn.line)) fn = f;
  }
  return { cls, fn };
}

/** `?User`, `User|null`, `App\\Models\\User` → `User` (the shared declared-type normalizer). */
const shortType = (type: string | null | undefined): string | null => receiverTypeName(type, "php");

function resolveEloquentEntity(
  ds: DataSourceInfo,
  a: FileAnalysis,
  models: ReadonlySet<string>,
  relationEntity: (field: string) => string | null,
): string | null {
  const name = ds.name;
  // The last relation call in the chain is the table the terminal verb runs on
  // (`$user->accounts()->transactions()->first()` reads transactions).
  const relationCalls = [...name.matchAll(/->\s*(\w+)\s*\(\s*\)/g)].map((m) => m[1]!);
  for (let i = relationCalls.length - 1; i >= 0; i--) {
    const target = relationEntity(relationCalls[i]!);
    if (target && models.has(target)) return target;
  }

  const { cls, fn } = enclosing(a, ds.line);
  const enclosingModel = cls && models.has(cls.name) ? cls.name : null;

  const staticRoot = /^([A-Za-z_\\]\w*(?:\\\w+)*)::/.exec(name)?.[1] ?? null;
  if (staticRoot) {
    if (RELATIVE_SCOPE_RE.test(staticRoot)) return enclosingModel;
    const short = staticRoot.split("\\").pop()!;
    return models.has(short) ? short : null;
  }

  // `$this->prop->…`: the property's declared type, or the promoted constructor parameter's.
  const prop = /^\$this\s*->\s*(\w+)\s*->/.exec(name)?.[1];
  if (prop && cls) {
    const declared = cls.properties.find((p) => p.name === prop || p.name === `$${prop}`)?.type
      ?? cls.methods.find((m) => m.name === "__construct")?.params.find((p) => p.name === prop)?.type;
    const type = shortType(declared);
    if (type && models.has(type)) return type;
  }

  // `$var->…`: a typed parameter or local of the enclosing function.
  const variable = /^\$(\w+)\s*->/.exec(name)?.[1];
  if (variable && variable !== "this" && fn) {
    const declared = fn.params.find((p) => p.name === variable)?.type
      ?? fn.localTypes?.find((l) => l.name === variable)?.type;
    const type = shortType(declared);
    if (type && models.has(type)) return type;
  }

  // Inside a model: its own query builder / instance is the model's table.
  if (enclosingModel && /^(?:\$this|\$query|\$builder|\$q)\b/.test(name)) return enclosingModel;
  return null;
}
