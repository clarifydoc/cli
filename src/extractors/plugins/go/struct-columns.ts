import type { ClassInfo, DataSourceInfo, FileAnalysis, FunctionInfo, PropertyInfo } from "../../../types/analysis.js";

/**
 * The column a Go struct member names, for the project pass that settles an ORM filter written
 * as a struct (`s.Get(&Club{ID: id})`, `s.Where(&Transfer{OtherClubID: x})`, a bean handed to
 * `s.Get(c)`): the statement states the MEMBER (`ID`), the table has a COLUMN (`club_id`), and a
 * route parameter's column must be spelled as `Where("club_id = ?", id)` would spell it.
 *
 *   type Club struct {
 *       ID       int64 `xorm:"'club_id' pk"`        ← the tag names it
 *       LeagueID int64 `gorm:"column:league_id"`    ← so does GORM's `column:`
 *       OtherID  int64                              ← neither: the naming convention (`other_id`)
 *   }
 *
 * The struct is declared wherever the project puts it: the package of the statement first (so a
 * same-named struct of another package, with other tags, is never used), a `pkg.Club` literal in the
 * package directory `pkg`, else the project's only one of that name. A name more than one struct
 * bears, none of them the statement's package, is left as written.
 */

/** xorm's and GORM's tag words that are not a column name. */
const TAG_WORDS = new Set([
  "pk", "autoincr", "index", "unique", "notnull", "null", "default", "created", "updated", "deleted", "version",
  "extends", "json", "jsonb", "text", "blob", "date", "datetime", "time", "timestamp", "timestampz", "bool", "int",
  "bigint", "float", "double", "varchar", "char", "bit", "tinyint", "smallint", "mediumint", "uuid", "binary",
  "varbinary", "numeric", "decimal", "real", "serial", "bigserial", "<-", "->", "-", "autoincrement", "comment",
]);

/**
 * The mapper convention of xorm's GonicMapper and GORM's naming strategy: a word starts at a capital after a
 * lower-case letter or digit, or at the last capital of a run a lower-case letter follows — an initialism stays
 * one word (`OtherClubID` → `other_club_id`, `ID` → `id`, `HTTPServer` → `http_server`).
 */
export function snakeColumn(member: string): string {
  return member
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * The column a member's tags name: xorm's quoted `'club_id'` (or an unquoted name no tag word claims) and
 * `column:club_id`, GORM's `column:club_id`, Beego's `orm:"column(club_id)"`. Undefined when no tag
 * names one; null when a tag opts the member out of the table (`xorm:"-"`, `gorm:"-"`).
 */
export function tagColumn(prop: Pick<PropertyInfo, "decorators">): string | null | undefined {
  for (const t of prop.decorators ?? []) {
    const m = /^(xorm|gorm|orm):"((?:[^"\\]|\\.)*)"$/.exec(t);
    if (!m) continue;
    const body = m[2]!;
    if (m[1] === "orm") {
      const c = /\bcolumn\(\s*([\w]+)\s*\)/.exec(body);
      if (c) return c[1]!;
      continue;
    }
    if (body.trim() === "-") return null;
    const col = /\bcolumn:\s*([\w]+)/.exec(body);
    if (col) return col[1]!;
    const quoted = /'([\w]+)'/.exec(body);
    if (quoted && m[1] === "xorm") return quoted[1]!;
    if (m[1] === "xorm") {
      const first = body.trim().split(/[\s;]+/)[0] ?? "";
      if (/^[A-Za-z_]\w*$/.test(first) && !TAG_WORDS.has(first.toLowerCase())) return first;
    }
  }
  return undefined;
}

/** A struct type as a statement or a parameter writes it, split: `*models.Club` → `{ pkg: "models", name: "Club" }`. */
function typeRef(text: string): { pkg?: string; name: string } | null {
  const m = /^(?:[*&]|\[\])*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)$/.exec(text.trim().replace(/\{\}?$/, "").replace(/\[[^\]]*\]$/, ""));
  return m ? { ...(m[1] ? { pkg: m[1] } : {}), name: m[2]! } : null;
}

type Declared = { dir: string; cls: ClassInfo };

/**
 * Settles each Go ORM statement's struct-condition members into columns, in place:
 * `whereFields[].fieldOf` rows get the column in `field`, `whereObjects[].columns` gets the
 * members whose column is not their name.
 */
export function mapStructFilterColumns(go: readonly FileAnalysis[]): void {
  if (!go.some((a) => a.dataSources?.some((d) => d.whereFields?.some((w) => w.fieldOf) || d.whereObjects))) return;
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
  const byName = new Map<string, Declared[]>();
  for (const a of go) {
    for (const cls of a.classes) {
      if (cls.kind === "interface") continue;
      (byName.get(cls.name) ?? byName.set(cls.name, []).get(cls.name)!).push({ dir: dirOf(a.filePath), cls });
    }
  }
  /** The struct a type names from a statement in `file`: undefined when no struct of that name is declared, null when it is ambiguous. */
  const declared = (ref: { pkg?: string; name: string }, file: string): ClassInfo | null | undefined => {
    const all = byName.get(ref.name) ?? [];
    if (all.length === 0) return undefined;
    if (ref.pkg) {
      const named = all.filter((c) => c.dir.split("/").filter(Boolean).pop() === ref.pkg);
      return named.length === 1 ? named[0]!.cls : named.length > 1 ? null : all.length === 1 ? all[0]!.cls : null;
    }
    const here = all.filter((c) => c.dir === dirOf(file));
    if (here.length > 0) return here.length === 1 ? here[0]!.cls : null;
    return all.length === 1 ? all[0]!.cls : null;
  };
  /** A member's column: its tag's, else the convention's. Null when the tag opts it out. */
  const columnOf = (cls: ClassInfo | undefined, member: string): string | null => {
    const prop = cls?.properties.find((p) => p.name === member);
    const tagged = prop ? tagColumn(prop) : undefined;
    return tagged === undefined ? snakeColumn(member) : tagged;
  };

  for (const a of go) {
    let fns: FunctionInfo[] | undefined;
    const functions = (): FunctionInfo[] => (fns ??= [...a.functions, ...a.classes.flatMap((c) => c.methods)]);
    for (const d of a.dataSources ?? []) {
      if (d.whereFields?.some((w) => w.fieldOf)) {
        // A member that is no column (opted out by its tag), or of a struct that more than one declaration
        // could be, names nothing the table has: the row is dropped rather than carry a member as a column.
        const settled: NonNullable<DataSourceInfo["whereFields"]> = [];
        for (const w of d.whereFields) {
          if (w.fieldOf) {
            const ref = typeRef(w.fieldOf);
            const cls = ref ? declared(ref, a.filePath) : undefined;
            delete w.fieldOf;
            if (cls === null) continue;
            const column = columnOf(cls, w.field);
            if (!column) continue;
            w.field = column;
          }
          // The same column named twice (`Where("id = ?", x)` and `&Club{ID: x}`) is one filter.
          if (!settled.some((s) => s.field === w.field)) settled.push(w);
        }
        if (settled.length > 0) d.whereFields = settled;
        else delete d.whereFields;
      }
      for (const o of d.whereObjects ?? []) {
        // The struct the object is: the declared type of the parameter (or the receiver), else the statement's entity.
        const owner = functions()
          .filter((f) => d.line >= f.line && d.line <= f.endLine)
          .sort((x, y) => x.endLine - x.line - (y.endLine - y.line))[0];
        let ref: ReturnType<typeof typeRef> = null;
        if (o.origin.kind === "param" && owner) ref = typeRef(owner.params[o.origin.index]?.type ?? "");
        else if (o.origin.kind === "receiver" && owner) ref = typeRef(a.classes.find((c) => c.methods.includes(owner))?.name ?? "");
        if (!ref && d.entity) ref = typeRef(d.entity);
        const cls = ref ? declared(ref, a.filePath) : undefined;
        if (!ref || cls === null) continue;
        const columns: Record<string, string> = {};
        for (const p of cls?.properties ?? []) {
          const column = columnOf(cls, p.name);
          if (column && column !== p.name) columns[p.name] = column;
        }
        if (Object.keys(columns).length > 0) o.columns = columns;
      }
    }
  }
}
