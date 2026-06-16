import type {
  ClassInfo,
  EntityRelation,
  FileAnalysis,
  Language,
  PropertyInfo,
  RailsSchemaTable,
} from "../../types/analysis.js";

/**
 * Input handed to every language entity extractor. Operates on the
 * already-extracted FileAnalysis (classes/imports/frameworks) plus the raw
 * source — deliberately source-text based, not AST based, so one extractor
 * works for both tree-sitter and regex languages (PropertyInfo carries no
 * decorator info, so relation/field detection re-scans class bodies anyway).
 */
export interface EntityExtractContext {
  analysis: FileAnalysis;
  sourceText: string;
  lines: string[];
}

export interface EntityExtractResult {
  /**
   * Canonical entity records. Merged into `analysis.classes` by name —
   * an existing class with the same name is enriched (decorators/properties/
   * implements unioned); otherwise the entity is added as a new node (covers
   * call-based models like Sequelize/Mongoose that have no class declaration).
   */
  entities: ClassInfo[];
  /** Relations between entities defined in this file. */
  relations: EntityRelation[];
  /**
   * Tables parsed from a Rails `db/schema.rb`, when this file IS the schema
   * dump. Carried through to `FileAnalysis.railsSchemaTables` so the
   * project-level join can attach columns to model entities defined elsewhere.
   */
  schemaTables?: RailsSchemaTable[];
}

/**
 * Abstract base for language-specific ORM entity extractors. Each Tier-A
 * language plugin provides one subclass (e.g. `JavaScriptEntityExtractor`)
 * that recognizes that ecosystem's entity definitions and emits entity
 * `ClassInfo`s + `EntityRelation`s.
 */
export abstract class EntityExtractor {
  /** Languages this extractor handles. */
  abstract readonly languages: Language[];

  /** Extract entities + relations from a single file. */
  abstract extract(ctx: EntityExtractContext): EntityExtractResult;

  /**
   * Project-level reconciliation across ALL analyzed files, run once after
   * per-file extraction. Default no-op; override for cross-file joins a
   * per-file pass cannot do — e.g. attaching Rails `db/schema.rb` columns to
   * model entities defined in other files. Mutates the analyses in place.
   */
  reconcileProject(_analyses: FileAnalysis[]): void {}

  /** Build an entity ClassInfo with the standard decorator convention. */
  protected entity(opts: {
    name: string;
    orm: string;
    properties?: PropertyInfo[];
    implementsList?: string[];
    extends?: string | null;
    line?: number;
    endLine?: number;
    extraDecorators?: string[];
  }): ClassInfo {
    return {
      name: opts.name,
      extends: opts.extends ?? null,
      implements: opts.implementsList ?? [],
      decorators: ["entity", opts.orm, ...(opts.extraDecorators ?? [])],
      methods: [],
      properties: opts.properties ?? [],
      isExported: true,
      line: opts.line ?? 1,
      endLine: opts.endLine ?? opts.line ?? 1,
    };
  }

  /** Build a column PropertyInfo with sensible defaults. */
  protected column(name: string, type: string | null = null): PropertyInfo {
    return { name, type, visibility: "public", isStatic: false, isReadonly: false };
  }

  /** Slice the source lines belonging to a class body (1-based line range). */
  protected bodyOf(ctx: EntityExtractContext, cls: ClassInfo): string[] {
    const start = Math.max(0, cls.line - 1);
    const end = cls.endLine && cls.endLine >= cls.line ? cls.endLine : ctx.lines.length;
    return ctx.lines.slice(start, end);
  }

  // ─── Multiline-aware parsing primitives (shared by all extractors) ────────
  //
  // ORM definitions frequently span multiple physical lines (decorators with
  // option objects, annotations with nested args, struct tags, schema fields).
  // Line-by-line regex scanning silently drops these. These helpers collapse
  // physical lines into balanced *logical* statements so a single regex can
  // match the whole construct.

  /**
   * Net bracket-depth change for `()[]{}` on a line, ignoring brackets inside
   * string literals (', ", `). Used to detect statement continuation.
   */
  protected bracketDelta(line: string): number {
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

  /**
   * Strip a trailing line-comment (any of `prefixes`, e.g. ["//"], ["#"],
   * ["--"]) that begins outside a string literal. Also removes single-line
   * `/* ... *​/` block comments. Returns the cleaned line.
   */
  protected stripLineComment(line: string, prefixes: readonly string[]): string {
    // Remove single-line block comments first.
    let s = line.replace(/\/\*.*?\*\//g, "");
    if (prefixes.length === 0) return s;
    let quote = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      for (const p of prefixes) {
        if (s.startsWith(p, i)) return s.slice(0, i);
      }
    }
    return s;
  }

  /**
   * Collapse physical lines into balanced *logical* statements. A statement
   * accumulates until its running bracket depth returns to ≤ 0, so multiline
   * decorators / annotations / field calls / struct literals become one entry.
   * Returns `{ text, line }` where `line` is the 0-based index (within `lines`)
   * of the statement's first physical line. Comments are stripped per `opts`.
   */
  protected logicalLines(
    lines: string[],
    opts: { lineComment?: readonly string[] } = {},
  ): Array<{ text: string; line: number }> {
    const prefixes = opts.lineComment ?? [];
    const out: Array<{ text: string; line: number }> = [];
    let buf = "";
    let startIdx = -1;
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const cleaned = this.stripLineComment(lines[i] ?? "", prefixes);
      if (startIdx === -1) {
        if (cleaned.trim() === "") continue;
        startIdx = i;
        buf = cleaned;
      } else {
        buf += "\n" + cleaned;
      }
      depth += this.bracketDelta(cleaned);
      if (depth <= 0) {
        out.push({ text: buf, line: startIdx });
        buf = "";
        startIdx = -1;
        depth = 0;
      }
    }
    if (startIdx !== -1) out.push({ text: buf, line: startIdx });
    return out;
  }

  /**
   * Group decorator/annotation/attribute lines with the member declaration they
   * precede. Handles decorators on their own line(s), inline decorators, and
   * multiple stacked decorators. `style` selects the syntax:
   *   "at"          → `@Name(...)`           (TypeScript, Java, Kotlin)
   *   "square"      → `[Name(...)]`          (C# attributes)
   *   "hash-square" → `#[Name(...)]`         (PHP 8 attributes)
   * Returns `{ decorators, declaration, line }` per member, where `decorators`
   * is the list of raw decorator strings and `declaration` is the member text.
   */
  protected decoratedMembers(
    body: string[],
    opts: { style?: "at" | "square" | "hash-square"; lineComment?: readonly string[] } = {},
  ): Array<{ decorators: string[]; declaration: string; line: number }> {
    const style = opts.style ?? "at";
    const logical = this.logicalLines(body, { lineComment: opts.lineComment });
    const members: Array<{ decorators: string[]; declaration: string; line: number }> = [];
    let pending: string[] = [];
    let pendingLine = -1;
    for (const ll of logical) {
      const { decorators, rest } = this.splitLeadingDecorators(ll.text.trim(), style);
      if (decorators.length > 0) {
        if (pendingLine < 0) pendingLine = ll.line;
        pending.push(...decorators);
        if (rest.trim()) {
          members.push({ decorators: pending, declaration: rest.trim(), line: pendingLine });
          pending = [];
          pendingLine = -1;
        }
      } else {
        members.push({
          decorators: pending,
          declaration: ll.text.trim(),
          line: pendingLine >= 0 ? pendingLine : ll.line,
        });
        pending = [];
        pendingLine = -1;
      }
    }
    if (pending.length > 0) {
      members.push({ decorators: pending, declaration: "", line: pendingLine });
    }
    return members;
  }

  /** Peel leading decorators of the given style off a logical-statement text. */
  private splitLeadingDecorators(
    text: string,
    style: "at" | "square" | "hash-square",
  ): { decorators: string[]; rest: string } {
    const decorators: string[] = [];
    let s = text;
    for (;;) {
      s = s.replace(/^\s+/, "");
      let open = -1;
      let nameStart = -1;
      if (style === "at") {
        if (!s.startsWith("@")) break;
        nameStart = 0;
        open = 1; // after '@'
      } else if (style === "hash-square") {
        if (!s.startsWith("#[")) break;
        const end = this.matchBracket(s, 1); // index of matching ']'
        if (end < 0) break;
        decorators.push(s.slice(0, end + 1));
        s = s.slice(end + 1);
        continue;
      } else {
        if (!s.startsWith("[")) break;
        const end = this.matchBracket(s, 0);
        if (end < 0) break;
        decorators.push(s.slice(0, end + 1));
        s = s.slice(end + 1);
        continue;
      }
      // "at" style: @Name optionally followed by a balanced (...) call.
      const nameMatch = s.slice(open).match(/^[A-Za-z_$][\w$.]*/);
      if (!nameMatch) break;
      let end = open + nameMatch[0].length;
      // optional whitespace then '('
      let j = end;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "(") {
        const close = this.matchBracket(s, j);
        if (close < 0) break;
        end = close + 1;
      }
      decorators.push(s.slice(nameStart, end));
      s = s.slice(end);
    }
    return { decorators, rest: s };
  }

  /** Index of the bracket matching the opener at `openIdx` (handles strings). */
  protected matchBracket(s: string, openIdx: number): number {
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
   * Unwrap generic / collection / nullable wrappers to the inner entity type
   * identifier. Handles `Promise<T>`, `Collection<T>`, `List<T>`, `Set<T>`,
   * `Array<T>`, `Observable<T>`, `Option<T>`, `T[]`, `T | null`, and nesting.
   * Returns the bare identifier (last segment of a dotted/namespaced name).
   */
  protected coreType(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let t = raw.trim();
    // Angle-bracket generic wrappers: Promise<T>, List<T>, Option<T>, Vec<T>, …
    const ANGLE = /^(?:Promise|Collection|List|Set|Array|ReadonlyArray|Observable|Option|Ref|Rel|Iterable|Seq|Vec|Box|Arc|Rc)\s*<\s*([^]*)>\s*$/;
    // Square-bracket wrappers (Python / SQLAlchemy 2.0): Mapped[T], list[T],
    // Optional[T], WriteOnlyMapped[T], …
    const SQUARE = /^(?:Mapped|WriteOnlyMapped|DynamicMapped|list|List|set|Set|frozenset|tuple|Sequence|Optional|Iterable|Collection)\s*\[\s*([^]*?)\s*\]$/;
    for (let guard = 0; guard < 10; guard++) {
      const before = t;
      // Strip a trailing optional marker / union with null|undefined.
      t = t.replace(/\?\s*$/, "").trim();
      t = t.replace(/\s*\|\s*(null|undefined)\b/gi, "").trim();
      const ang = t.match(ANGLE);
      if (ang) t = ang[1]!.trim();
      const sq = t.match(SQUARE);
      if (sq) t = sq[1]!.trim();
      // Strip a trailing array marker (`T[]`).
      t = t.replace(/\[\]\s*$/, "").trim();
      if (t === before) break;
    }
    // For comma lists (e.g. `Dict[str, User]`) the entity is the last arg.
    if (t.includes(",")) {
      const parts = t.split(",");
      t = parts[parts.length - 1]!.trim();
    }
    // Strip quotes (forward refs like "Post").
    t = t.replace(/^["'`]|["'`]$/g, "");
    // Take the last dotted/namespaced segment.
    const seg = t.split(/[.:]/).pop() ?? t;
    const id = seg.match(/[A-Za-z_$][\w$]*/);
    return id ? id[0] : null;
  }

  /**
   * The lines strictly INSIDE a class's outermost braces (the brace interior),
   * excluding the `class X {` opener and the closing `}`. Use this — not
   * `bodyOf` — when feeding `decoratedMembers`/`logicalLines`, because the
   * class-opening `{` would otherwise make the whole body one unbalanced
   * (and therefore u/nparsed) logical statement.
   */
  protected bodyInteriorOf(ctx: EntityExtractContext, cls: ClassInfo): string[] {
    const joined = this.bodyOf(ctx, cls).join("\n");
    const open = joined.indexOf("{");
    if (open < 0) return [];
    const close = this.matchBracket(joined, open);
    const interior = close > open ? joined.slice(open + 1, close) : joined.slice(open + 1);
    return interior.split("\n");
  }
}
