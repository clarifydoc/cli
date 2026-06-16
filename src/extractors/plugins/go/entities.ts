import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Go ORM entity extractor. Go is regex-parsed, so `ctx.analysis.classes` does
 * not reliably contain struct types — extraction is driven by scanning
 * `ctx.lines` for `type X struct { ... }` definitions and the Ent
 * `Fields()` / `Edges()` method bodies directly.
 *
 * Supports:
 *   - GORM        — `gorm.Model` embed / backtick `gorm:"..."` tags
 *                   (foreignKey / references / many2many / polymorphic)
 *   - Ent         — `ent.Schema` structs + `field.X(...)` / `edge.To|From(...)`
 *                   with builder-chain options (.Optional/.Unique/.Inverse)
 *   - Beego ORM   — `orm.RegisterModel(new(X) | &X{})` / backtick `orm:"..."`
 *                   tags with compound `rel(...)` / `reverse(...)` directives
 *
 * All multiline constructs (struct tags split across physical lines, multiline
 * Ent builder chains) are handled by collapsing physical lines into balanced
 * logical statements via the shared `logicalLines` base helper. Never throws —
 * anything that can't be parsed is skipped.
 */

interface StructBlock {
  name: string;
  startLine: number; // 1-based line of the `type X struct {`
  endLine: number; // 1-based line of the closing `}`
  /** Logical (brace/paren-balanced) statements strictly inside the braces. */
  body: { text: string; line: number }[];
  /** True when no closing brace was found (malformed / unterminated). */
  unterminated: boolean;
}

interface StructField {
  name: string; // field identifier, or "" for an embedded/anonymous field
  rawType: string; // type as written, e.g. "*User", "[]Post", "sql.NullInt64"
  /** Reference type for entity matching: leading *, [], map[...], pkg. stripped. */
  refType: string;
  /** Column/display type: array & pointer markers stripped, pkg qualifier kept. */
  columnType: string;
  isSlice: boolean;
  isFunc: boolean; // func-typed field — never a column or relation
  tags: Record<string, string>; // parsed backtick struct tags by key
  line: number;
}

const GO_LINE_COMMENT = ["//"] as const;

export class GoEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["go"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];

    try {
      const lines = ctx.lines ?? [];
      const structs = this.findStructs(lines);
      const structNames = new Set(structs.map((s) => s.name));

      // Models explicitly registered with Beego's ORM.
      const beegoRegistered = this.findBeegoRegistered(lines);

      // Ent schema method bodies, keyed by receiver type name.
      const entFields = this.collectEntMethod(lines, "Fields");
      const entEdges = this.collectEntMethod(lines, "Edges");

      const emitted = new Set<string>();

      for (const struct of structs) {
        // Skip clearly malformed blocks rather than letting them claim lines.
        if (struct.unterminated && struct.body.length === 0) continue;

        const fields: StructField[] = [];
        for (const bl of struct.body) {
          try {
            const f = this.parseField(bl.text, bl.line);
            if (f) fields.push(f);
          } catch {
            // Skip a single unparseable member; keep the rest of the struct.
          }
        }

        // ── Ent schema struct: `type X struct { ent.Schema }` ──────────────
        const isEnt =
          fields.some((f) => f.name === "" && f.refType === "Schema" && f.rawType.includes("ent.")) ||
          // Some schemas only declare the methods, not the embed — accept when
          // the struct has matching Ent Fields()/Edges() method bodies.
          entFields.has(struct.name) ||
          entEdges.has(struct.name);
        if (isEnt) {
          if (!emitted.has(struct.name)) {
            const props: PropertyInfo[] = [];
            for (const fb of entFields.get(struct.name) ?? []) {
              for (const c of this.parseEntFields(fb)) props.push(this.column(c.name, c.type));
            }
            const edgeRels = (entEdges.get(struct.name) ?? []).flatMap((eb) =>
              this.parseEntEdges(struct.name, eb),
            );
            entities.push(
              this.entity({
                name: struct.name,
                orm: "ent",
                properties: props,
                implementsList: this.uniq(edgeRels.map((r) => r.toEntity)),
                line: struct.startLine,
                endLine: struct.endLine,
              }),
            );
            emitted.add(struct.name);
            for (const r of edgeRels) relations.push(r);
          }
          continue;
        }

        // ── Detect ORM ownership via genuine markers only ──────────────────
        const hasBeegoTag = fields.some((f) => f.tags.orm !== undefined);
        const isBeego = beegoRegistered.has(struct.name) || hasBeegoTag;

        const embedsGormModel = fields.some(
          (f) => f.name === "" && f.refType === "Model" && f.rawType.includes("gorm."),
        );
        const hasGormTag = fields.some((f) => f.tags.gorm !== undefined);
        const isGorm = embedsGormModel || hasGormTag;

        // No genuine ORM marker → not an entity (reduces false positives).
        if (!isGorm && !isBeego) continue;

        const orm = isGorm ? "gorm" : "beego-orm";
        const props: PropertyInfo[] = [];
        const fieldNames = new Set(fields.filter((f) => f.name).map((f) => f.name));

        for (const f of fields) {
          if (f.name === "") continue; // embedded mixin/interface/value — never a column
          if (f.isFunc) continue; // func-typed field — behaviour, not data
          // A named field whose type is another struct in this file is a
          // relation, not a scalar column.
          if (structNames.has(f.refType)) continue;
          // A GORM polymorphic anchor (`interface{}` carrying a `polymorphic:`
          // tag) is a relation placeholder, not a data column.
          if (isGorm && /\bpolymorphic\s*:/i.test(f.tags.gorm ?? "")) continue;
          props.push(this.column(f.name, f.columnType || null));
        }

        if (!emitted.has(struct.name)) {
          const related = isGorm
            ? this.gormRelations(struct.name, fields, structNames, fieldNames)
            : this.beegoRelations(struct.name, fields, structNames);
          entities.push(
            this.entity({
              name: struct.name,
              orm,
              properties: props,
              implementsList: this.uniq(related.map((r) => r.toEntity)),
              line: struct.startLine,
              endLine: struct.endLine,
            }),
          );
          emitted.add(struct.name);
          for (const r of related) relations.push(r);
        }
      }
    } catch {
      // Defensive: never let a parse glitch break the whole analysis.
    }

    return { entities, relations };
  }

  // ── Struct discovery ──────────────────────────────────────────────────────

  /**
   * Find all `type X struct { ... }` blocks. The body is captured as balanced
   * *logical* statements (via `logicalLines`) so a field whose backtick struct
   * tag is split across several physical lines collapses into one entry.
   */
  private findStructs(lines: string[]): StructBlock[] {
    const structs: StructBlock[] = [];
    const open = /^\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{(.*)$/;

    for (let i = 0; i < lines.length; i++) {
      const m = open.exec(this.stripLineComment(lines[i] ?? "", GO_LINE_COMMENT));
      if (!m) continue;
      const name = m[1]!;
      const startLine = i + 1;

      // Net braces opened on the declaration line (after `struct {`), counting
      // the `struct {` brace itself. Carry any unterminated string/backtick
      // state forward so a multiline raw tag (or a `{`/`}` inside a tag) does
      // not corrupt the struct boundary.
      const sameLineRest = m[2] ?? "";
      const opener = this.scanBraces(sameLineRest, null);
      let depth = 1 + opener.depth;
      let strState: string | null = opener.inStr;

      // Single-line struct: `type X struct {}` or `type X struct { A int }`.
      if (depth <= 0) {
        const inner = sameLineRest.replace(/\}.*$/, "");
        const body = inner.trim()
          ? this.logicalLines([inner], { lineComment: GO_LINE_COMMENT }).map((ll) => ({
              text: ll.text,
              line: startLine,
            }))
          : [];
        structs.push({ name, startLine, endLine: startLine, body, unterminated: false });
        continue;
      }

      // Multiline struct: collect the physical lines of the body, then collapse
      // them into balanced logical statements in one pass.
      const physical: string[] = [];
      let endLine = startLine;
      let unterminated = true;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const text = lines[j]!;
        // Stop a runaway (missing-brace) struct before it swallows the next
        // top-level declaration, so a malformed struct never claims another's
        // body/line range. Suppressed while inside a multiline raw string so a
        // `type ... struct {` literally written inside a tag can't trip it.
        if (!strState && (open.test(this.stripLineComment(text, GO_LINE_COMMENT)) || /^\s*func\s/.test(text))) {
          endLine = j; // cap just before the new declaration
          break;
        }
        const scan = this.scanBraces(text, strState);
        const net = scan.depth;
        strState = scan.inStr;
        if (depth + net <= 0) {
          // Closing brace on this line; keep any field content preceding it.
          const beforeClose = text.replace(/\}[^}]*$/, "");
          if (beforeClose.trim()) physical.push(beforeClose);
          endLine = j + 1;
          unterminated = false;
          break;
        }
        depth += net;
        physical.push(text);
      }

      // Unterminated struct: cap endLine at the last consumed line so it never
      // swallows subsequent structs (the body lines are still best-effort).
      if (unterminated && endLine === startLine) {
        endLine = Math.min(lines.length, Math.max(startLine, j));
      }

      // Map each logical statement's 0-based offset back to a 1-based file line.
      const logical = this.logicalLines(physical, { lineComment: GO_LINE_COMMENT });
      const body = logical.map((ll) => ({ text: ll.text, line: startLine + 1 + ll.line }));

      structs.push({ name, startLine, endLine, body, unterminated });
      i = Math.max(i, j - 1);
    }
    return structs;
  }

  /**
   * Scan one line for net brace depth, ignoring braces inside strings/backticks,
   * carrying string state IN and OUT so a raw backtick tag (or any string) that
   * spans multiple physical lines is handled correctly. `inStr` is the open
   * quote char at the start of the line (null when not inside a string).
   */
  private scanBraces(text: string, inStr: string | null): { depth: number; inStr: string | null } {
    let depth = 0;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (inStr) {
        if (ch === inStr) inStr = null;
        else if (ch === "\\" && inStr !== "`") k++; // skip escaped char (not in raw strings)
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    return { depth, inStr };
  }

  /** Net change in brace depth for a single line (no carried string state). */
  private netBraces(text: string): number {
    return this.scanBraces(text, null).depth;
  }

  // ── Field parsing ─────────────────────────────────────────────────────────

  /**
   * Parse a single (already logical / brace-balanced) struct-body statement
   * into a field. Returns null for comments, blanks, and anything that doesn't
   * look like a field declaration.
   */
  private parseField(raw: string, line: number): StructField | null {
    // Flatten the (possibly multiline) logical statement to one physical line so
    // a backtick tag split across lines is captured whole. Newlines inside a raw
    // backtick tag become spaces, which the tag-key regex tolerates.
    let text = raw.replace(/\s*\n\s*/g, " ").trim();

    // Pull out the trailing backtick struct tag (raw string — may contain
    // anything but a backtick). Captured from the full flattened statement so
    // multiline tags survive.
    let tagSource = "";
    const tagMatch = /`([^`]*)`/.exec(text);
    if (tagMatch) {
      tagSource = tagMatch[1]!;
      text = (text.slice(0, tagMatch.index) + text.slice(tagMatch.index + tagMatch[0].length)).trim();
    }

    if (!text) return null;
    if (text.startsWith("//") || text.startsWith("/*")) return null;

    const tags = this.parseTags(tagSource);

    // Embedded / anonymous field: a single (possibly qualified, pointer) type
    // with no field name. e.g. `gorm.Model`, `ent.Schema`, `*Base`, `io.Reader`.
    const embedded = /^([*]?[A-Za-z_][\w.]*)$/.exec(text);
    if (embedded) {
      const rawType = embedded[1]!;
      return {
        name: "",
        rawType,
        refType: this.refType(rawType),
        columnType: this.columnType(rawType),
        isSlice: false,
        isFunc: false,
        tags,
        line,
      };
    }

    // Named field: `Name Type` (type may be `[]pkg.T`, `*T`, `map[...]...`,
    // `func(...) ...`, `chan T`, etc.).
    const named = /^([A-Za-z_]\w*)\s+([\s\S]+)$/.exec(text);
    if (!named) return null;
    const name = named[1]!;
    const rawType = named[2]!.trim();

    // Func-typed fields are behaviour, not data — flag so callers skip them.
    const isFunc = /^func\s*\(/.test(rawType);

    return {
      name,
      rawType,
      refType: this.refType(rawType),
      columnType: this.columnType(rawType),
      isSlice: /^\s*\[\s*\]/.test(rawType) || /^\[\s*\]/.test(rawType),
      isFunc,
      tags,
      line,
    };
  }

  /**
   * Reference type used for entity matching: strip slice/pointer/array/ellipsis
   * markers and map value, strip generic args, then drop a package qualifier so
   * `[]*pkg.User` → `User`. Use this when resolving relations / FKs.
   */
  private refType(raw: string): string {
    let t = this.stripContainers(raw);
    // Strip generic args: `Foo[Bar]` -> `Foo`.
    t = t.replace(/\[.*$/, "");
    // Strip a single package qualifier: `pkg.User` -> `User`.
    const dot = t.lastIndexOf(".");
    if (dot >= 0) t = t.slice(dot + 1);
    return t.trim();
  }

  /**
   * Column/display type: strip container markers (slice/pointer/array/map) but
   * PRESERVE the package qualifier — `sql.NullInt64` stays `sql.NullInt64`,
   * `uuid.UUID` stays `uuid.UUID` — since the qualifier carries DB-type meaning.
   */
  private columnType(raw: string): string {
    let t = this.stripContainers(raw);
    // For func types there is no meaningful column type.
    if (/^func\s*\(/.test(t)) return "";
    return t.trim();
  }

  /** Strip leading `*`, `[]`/`[N]`, `...`, and unwrap `map[K]V` to V (once). */
  private stripContainers(raw: string): string {
    let t = raw.trim();
    let prev = "";
    while (prev !== t) {
      prev = t;
      t = t.replace(/^\*/, "");
      t = t.replace(/^\[\s*\d*\s*\]/, "");
      t = t.replace(/^\.\.\./, "");
      t = t.trim();
    }
    // For maps, take the value type (after the matching `]` of the key).
    const mapMatch = /^map\[[^\]]*\]\s*([\s\S]+)$/.exec(t);
    if (mapMatch) t = mapMatch[1]!.trim().replace(/^\*/, "");
    return t.trim();
  }

  /** Parse a Go struct tag string into key→value (e.g. `gorm:"foo" json:"bar"`). */
  private parseTags(tagSource: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!tagSource) return out;
    // Tolerant of newlines / extra whitespace between key:"value" pairs.
    const re = /(\w+)\s*:\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tagSource)) !== null) out[m[1]!] = m[2]!;
    return out;
  }

  // ── GORM relations ──────────────────────────────────────────────────────

  private gormRelations(
    from: string,
    fields: StructField[],
    structNames: Set<string>,
    fieldNames: Set<string>,
  ): EntityRelation[] {
    const rels: EntityRelation[] = [];
    // Field lookup so a belongs-to relation can inspect its FK column's
    // nullability (pointer type / `nullable` tag), which lives on a *different*
    // field (e.g. `AuthorID *int`) than the association field (`Author User`).
    const byName = new Map(fields.filter((f) => f.name).map((f) => [f.name, f]));
    const fkIsNullable = (fk: string | null): boolean => {
      if (!fk) return false;
      const col = byName.get(fk);
      if (!col) return false;
      return col.rawType.trim().startsWith("*") || /\bnullable\b/i.test(col.tags.gorm ?? "");
    };
    for (const f of fields) {
      if (f.name === "" || f.isFunc) continue;
      const gormTag = f.tags.gorm ?? "";

      // Polymorphic owning side: `gorm:"polymorphic:Owner"`. The concrete type
      // is `interface{}`, so there is no struct target — record the association
      // against the polymorphic name as a (low-certainty) one-to-one anchor.
      const poly = /polymorphic\s*:\s*([A-Za-z_]\w*)/i.exec(gormTag);
      if (poly && !structNames.has(f.refType)) {
        rels.push({
          fromEntity: from,
          fromField: f.name,
          toEntity: poly[1]!,
          cardinality: "many-to-one",
          orm: "gorm",
          // Tag is explicit, but the target is an abstract polymorphic name.
          confidence: "AMBIGUOUS",
        });
        continue;
      }

      // Only genuine associations (field type is another known struct) are
      // relations; scalar / value columns are skipped.
      if (!structNames.has(f.refType)) continue;

      // Explicit many-to-many via `gorm:"many2many:join_table;..."`.
      const m2m = /many2many\s*:\s*([A-Za-z_]\w*)/i.exec(gormTag);
      if (m2m || /many2many\b/.test(gormTag)) {
        rels.push({
          fromEntity: from,
          fromField: f.name,
          toEntity: f.refType,
          cardinality: "many-to-many",
          joinTable: m2m ? m2m[1]! : null,
          orm: "gorm",
          confidence: "EXTRACTED",
        });
        continue;
      }

      const explicitFk = this.gormTagKey(gormTag, "foreignKey");
      const explicitRef = this.gormTagKey(gormTag, "references");
      const hasExplicit = explicitFk !== null || explicitRef !== null;
      // Nullable when the FK column is a pointer OR the tag says so.
      const optional = f.rawType.trim().startsWith("*") || /\bnullable\b/i.test(gormTag);

      // Slice of a struct type → one-to-many (has-many).
      if (f.isSlice) {
        rels.push({
          fromEntity: from,
          fromField: f.name,
          toEntity: f.refType,
          cardinality: "one-to-many",
          foreignKey: explicitFk ?? null,
          orm: "gorm",
          // An explicit foreignKey/references tag is EXTRACTED; otherwise the
          // has-many is derived purely from the slice shape (INFERRED).
          confidence: hasExplicit ? "EXTRACTED" : "INFERRED",
        });
        continue;
      }

      // Named (possibly pointer) struct field → belongs-to (many-to-one).
      // FK = explicit gorm tag, else the convention `<Field>ID` / `<Type>ID`.
      const conventionFk = fieldNames.has(`${f.name}ID`)
        ? `${f.name}ID`
        : fieldNames.has(`${f.refType}ID`)
          ? `${f.refType}ID`
          : null;
      const fk = explicitFk ?? conventionFk;
      rels.push({
        fromEntity: from,
        fromField: f.name,
        toEntity: f.refType,
        cardinality: "many-to-one",
        foreignKey: fk,
        // Optional when the association field is a pointer, its own tag says so,
        // or the resolved FK column is itself a pointer / `nullable`.
        optional: optional || fkIsNullable(fk),
        orm: "gorm",
        // Explicit tag → EXTRACTED regardless of whether the FK field exists;
        // pure naming convention → INFERRED.
        confidence: hasExplicit ? "EXTRACTED" : "INFERRED",
      });
    }
    return rels;
  }

  /** Pull a `<key>:Value` value (foreignKey / references) from a gorm tag. */
  private gormTagKey(gormTag: string, key: string): string | null {
    const re = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_]\\w*)`, "i");
    const m = re.exec(gormTag);
    return m ? m[1]! : null;
  }

  // ── Beego relations ──────────────────────────────────────────────────────

  private beegoRelations(
    from: string,
    fields: StructField[],
    structNames: Set<string>,
  ): EntityRelation[] {
    const rels: EntityRelation[] = [];
    for (const f of fields) {
      if (f.name === "" || f.isFunc) continue;
      if (!structNames.has(f.refType)) continue;
      const tag = f.tags.orm ?? "";

      // Collect the arguments of every rel(...) / reverse(...) directive so
      // compound tags like `rel(fk);column:author_id` and `rel(fk,reverse)`
      // parse correctly regardless of ordering or extra whitespace.
      const relArgs = this.beegoCallArgs(tag, "rel");
      const reverseArgs = this.beegoCallArgs(tag, "reverse");

      let cardinality: EntityRelation["cardinality"] | null = null;
      let explicit = false;
      if (relArgs.includes("fk")) {
        cardinality = "many-to-one";
        explicit = true;
      } else if (relArgs.includes("one")) {
        cardinality = "one-to-one";
        explicit = true;
      } else if (relArgs.includes("m2m")) {
        cardinality = "many-to-many";
        explicit = true;
      } else if (reverseArgs.includes("many")) {
        // reverse(many) is the non-owning side: cardinality is clear, but the
        // FK lives on the owning side, so it is not declared here.
        cardinality = "one-to-many";
        explicit = true;
      } else if (reverseArgs.includes("one")) {
        cardinality = "one-to-one";
        explicit = true;
      } else if (f.isSlice) {
        cardinality = "one-to-many";
      }

      if (!cardinality) continue;

      // Owning side may name its FK column via `column:author_id`.
      const isReverse = reverseArgs.length > 0;
      const fkCol = !isReverse ? this.beegoTagValue(tag, "column") : null;

      rels.push({
        fromEntity: from,
        fromField: f.name,
        toEntity: f.refType,
        cardinality,
        foreignKey: fkCol,
        // The FK is only knowable on the owning (rel(...)) side; reverse() sides
        // declare cardinality but no FK, so they stay AMBIGUOUS on the FK.
        confidence: explicit ? (isReverse ? "AMBIGUOUS" : "EXTRACTED") : "INFERRED",
        orm: "beego-orm",
      });
    }
    return rels;
  }

  /** Extract the comma-split arguments of a `name(...)` directive in a tag. */
  private beegoCallArgs(tag: string, name: string): string[] {
    const re = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`, "i");
    const m = re.exec(tag);
    if (!m) return [];
    return m[1]!
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /** Read a `key:value` directive value from a `;`-delimited beego tag. */
  private beegoTagValue(tag: string, key: string): string | null {
    const re = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_]\\w*)`, "i");
    const m = re.exec(tag);
    return m ? m[1]! : null;
  }

  // ── Beego registration scan ───────────────────────────────────────────────

  /**
   * Collect names from `orm.RegisterModel(...)` and `RegisterModelWithPrefix`,
   * handling all argument shapes: `new(X)`, `new(&X)`, `&X{}`, `X{}`, and
   * multiple comma-separated models in a single call (e.g.
   * `RegisterModel(new(User), &Post{})`).
   */
  private findBeegoRegistered(lines: string[]): Set<string> {
    const names = new Set<string>();
    // Match a whole RegisterModel[...](<args>) call, capturing the arg list.
    const callRe = /RegisterModel(?:WithPrefix|WithSuffix)?\s*\(([\s\S]*?)\)\s*$/;
    // Within the arg list: new(&?X), &X{}, or bare X{}.
    const modelRe = /(?:new\(\s*&?([A-Za-z_][\w.]*)\s*\)|&\s*([A-Za-z_][\w.]*)\s*\{|\b([A-Za-z_][\w.]*)\s*\{\s*\})/g;

    // Join lines so a call split across lines is still seen, then scan logically.
    const logical = this.logicalLines(lines, { lineComment: GO_LINE_COMMENT });
    for (const ll of logical) {
      const text = ll.text;
      if (!/RegisterModel/.test(text)) continue;
      // The args may contain nested parens (new(...)); take everything between
      // the first `(` after RegisterModel and the matching close.
      const startIdx = text.search(/RegisterModel(?:WithPrefix|WithSuffix)?\s*\(/);
      if (startIdx < 0) continue;
      const parenIdx = text.indexOf("(", startIdx);
      const close = this.matchBracket(text, parenIdx);
      const args = close > parenIdx ? text.slice(parenIdx + 1, close) : text.slice(parenIdx + 1);
      let m: RegExpExecArray | null;
      modelRe.lastIndex = 0;
      while ((m = modelRe.exec(args)) !== null) {
        const raw = m[1] ?? m[2] ?? m[3];
        if (raw) names.add(this.refType(raw));
      }
      // Fall back to the simple tail regex for odd single-arg forms.
      const tail = callRe.exec(text);
      if (tail) {
        modelRe.lastIndex = 0;
        let t: RegExpExecArray | null;
        while ((t = modelRe.exec(tail[1]!)) !== null) {
          const raw = t[1] ?? t[2] ?? t[3];
          if (raw) names.add(this.refType(raw));
        }
      }
    }
    return names;
  }

  // ── Ent method-body collection ────────────────────────────────────────────

  /**
   * Collect the bodies of `func (X) Fields()` / `func (X) Edges()` methods,
   * keyed by the receiver type name. Handles pointer/value receivers and named
   * or anonymous receivers. A receiver may appear more than once (e.g. across
   * conceptual mixins in the same file), so bodies accumulate into a list.
   */
  private collectEntMethod(lines: string[], method: "Fields" | "Edges"): Map<string, string[]> {
    const out = new Map<string, string[]>();
    // func (X) Fields() ...   or   func (r X) Fields() ...   (X may be *X)
    const re = new RegExp(
      `^\\s*func\\s*\\(\\s*(?:[A-Za-z_]\\w*\\s+)?\\*?([A-Za-z_]\\w*)\\s*\\)\\s*${method}\\s*\\(`,
    );
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i] ?? "");
      if (!m) continue;
      const recv = m[1]!;

      // Capture the function body by tracking brace depth from the signature.
      let depth = 0;
      let started = false;
      const body: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const text = lines[j]!;
        const before = depth;
        depth += this.netBraces(text);
        if (!started && depth > before) started = true;
        if (started) {
          if (j > i) body.push(text);
          else {
            const braceIdx = text.indexOf("{");
            if (braceIdx >= 0) body.push(text.slice(braceIdx + 1));
          }
        }
        if (started && depth <= 0) break;
      }
      const existing = out.get(recv) ?? [];
      existing.push(body.join("\n"));
      out.set(recv, existing);
      i = Math.max(i, j);
    }
    return out;
  }

  /**
   * Split an Ent Fields()/Edges() body into one segment per builder call. Each
   * `field.` / `edge.` occurrence starts a segment that runs up to (but not
   * including) the next such occurrence, so every builder chain — including its
   * `.Optional()` / `.Unique()` / `.Inverse(...)` tail — is captured in
   * isolation. Necessary because the whole `return []ent.Field{ ... }` literal
   * collapses into a single brace-balanced logical statement.
   */
  private splitEntCalls(body: string, prefix: "field" | "edge"): string[] {
    // Flatten to a single string (chains routinely span physical lines).
    const text = body.replace(/\r?\n/g, " ");
    const starts: number[] = [];
    const re = new RegExp(`\\b${prefix}\\.`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) starts.push(m.index);
    const segs: string[] = [];
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1]! : text.length;
      segs.push(text.slice(starts[i]!, end));
    }
    return segs;
  }

  /**
   * Parse Ent column declarations from a Fields() body, one per builder call,
   * capturing builder-chain options. Returns the column name + Ent builder type
   * (e.g. "String", "Int").
   */
  private parseEntFields(body: string): { name: string; type: string | null }[] {
    const cols: { name: string; type: string | null }[] = [];
    const head = /^field\.([A-Za-z_]\w*)\s*\(\s*"([^"]+)"/;
    for (const seg of this.splitEntCalls(body, "field")) {
      const m = head.exec(seg.trim());
      if (!m) continue;
      cols.push({ name: m[2]!, type: m[1]! });
    }
    return cols;
  }

  /**
   * Parse Ent edges from an Edges() body, one per builder call. Handles:
   *   - `edge.To("posts", Post.Type)`            → one-to-many
   *   - `edge.From("author", User.Type)`         → many-to-one (inverse side)
   *   - parenthesized type refs `(*Item).Type`   → toEntity = Item
   *   - `.Unique()`  on the chain                → collapses *-to-many to *-to-one
   *   - `.Inverse("field")`                      → populates inverseField
   */
  private parseEntEdges(from: string, body: string): EntityRelation[] {
    const rels: EntityRelation[] = [];
    // edge.To|From("name", <typeref>.Type ...). The type ref allows a leading
    // `(`, `*`, dotted package path, and a trailing `)` for `(*Item).Type`.
    const head = /^edge\.(To|From)\s*\(\s*"([^"]+)"\s*,\s*\(?\s*\*?\s*([A-Za-z_][\w.]*)\s*\)?\s*\.\s*Type/;
    for (const seg of this.splitEntCalls(body, "edge")) {
      const text = seg.trim();
      const m = head.exec(text);
      if (!m) continue;
      const direction = m[1]!;
      const fromField = m[2]!;
      const toEntity = this.refType(m[3]!);

      // Builder-chain options.
      const unique = /\.\s*Unique\s*\(/.test(text);
      const inv = /\.\s*Inverse\s*\(\s*"([^"]+)"/.exec(text);
      const inverseField = inv ? inv[1]! : null;

      let cardinality: EntityRelation["cardinality"];
      if (direction === "To") {
        // edge.To is the owning has-many; .Unique() makes it one-to-one.
        cardinality = unique ? "one-to-one" : "one-to-many";
      } else {
        // edge.From is the inverse belongs-to; .Unique() keeps it many-to-one,
        // a non-unique From is a many-to-many back-reference.
        cardinality = unique ? "many-to-one" : "many-to-many";
      }

      rels.push({
        fromEntity: from,
        fromField,
        toEntity,
        cardinality,
        inverseField,
        orm: "ent",
        confidence: "EXTRACTED",
      });
    }
    return rels;
  }

  // ── Misc ────────────────────────────────────────────────────────────────

  private uniq(items: string[]): string[] {
    return Array.from(new Set(items.filter(Boolean)));
  }
}
