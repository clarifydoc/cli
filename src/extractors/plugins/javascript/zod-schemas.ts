import type { Node } from "web-tree-sitter";
import type { ClassInfo, PropertyInfo } from "../../../types/analysis.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * zod schemas as the request types they validate.
 *
 *   export const createUser = z.object({
 *     email: z.string().email(),
 *     age: z.number().int().optional(),
 *     role: z.enum(["admin", "user"]),
 *     address: addressSchema,
 *     tags: z.array(z.string()),
 *   });
 *
 * is a class `createUser` (decorated `zod-schema`) whose properties carry the
 * TypeScript spelling of each field's type — `string`, `number`,
 * `'admin' | 'user'`, `addressSchema`, `string[]` — and `isRequired` unless
 * the field is `.optional()`/`.nullish()`/has a `.default()`. A nested
 * `z.object` field is a class of its own, `createUser_address`, and
 * `base.extend({ … })` a class that extends `base`. An inline schema a tRPC
 * procedure takes (`byId: publicProcedure.input(z.object({ id: z.string() }))`
 * in `postRouter`) is named after the procedure, `postRouter.byId.input`, the
 * name `routes/trpc.ts` gives the procedure's body parameter. The
 * request-schema pass then flattens a body typed by the schema's name with
 * the TypeScript hooks, as it does any class. Only a schema bound to a name
 * (`const x = z.object(…)`, possibly `.strict()`ed, or `y.extend(…)`) is read;
 * the binding never joins a handler by its text — a route names the schema
 * it validates with (`schema.parse(req.body)`, `validate(schema)`,
 * `.input(schema)`).
 *
 * joi schemas read the same way (`const user = Joi.object({ … })`, or
 * `Joi.object().keys({ … })`, `base.keys({ … })` extending `base`), with
 * joi's rule that a field is optional until `.required()`; celebrate's
 * re-exported `Joi` counts. A drizzle-zod schema
 * (`createInsertSchema(users)`, `createSelectSchema`, `createUpdateSchema`,
 * possibly `.omit`/`.pick`/`.extend`/`.partial`ed) is the columns of a table
 * declared in the same file, required as drizzle-zod makes them: an insert
 * needs a not-null column without a default, a select every column, an
 * update none.
 */

const ZOD_IMPORT_RE = /import\s+(?:\{\s*([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]zod(?:\/v\d)?['"]/g;

/** The names the file binds zod's namespace to (`z`, `zod`). */
export function zodNamespaces(sourceText: string): Set<string> {
  const out = new Set<string>();
  for (const m of sourceText.matchAll(ZOD_IMPORT_RE)) {
    if (m[1]) for (const part of m[1].split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name === "z") out.add(alias ?? "z");
    }
    if (m[2]) out.add(m[2]);
    if (m[3]) out.add(m[3]);
  }
  return out;
}

const JOI_IMPORT_RE = /import\s+(?:\{\s*([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](?:joi|@hapi\/joi|celebrate)['"]|\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](?:joi|@hapi\/joi)['"]\s*\)/g;

/** The names the file binds joi to (`Joi`, celebrate's re-exported `Joi`). */
export function joiNamespaces(sourceText: string): Set<string> {
  const out = new Set<string>();
  for (const m of sourceText.matchAll(JOI_IMPORT_RE)) {
    const fromCelebrate = m[0].includes("celebrate");
    if (m[1]) for (const part of m[1].split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name === "Joi") out.add(alias ?? "Joi");
    }
    if (!fromCelebrate && (m[2] || m[3])) out.add((m[2] ?? m[3])!);
    if (m[4]) out.add(m[4]);
  }
  return out;
}

const DRIZZLE_ZOD_RE = /import\s+\{\s*([^}]*)\}\s+from\s+['"](?:drizzle-zod|drizzle-orm\/zod)['"]/g;
type DrizzleMode = "insert" | "select" | "update";

/** `createInsertSchema` (or its alias) → insert, … for the drizzle-zod factories the file imports. */
function drizzleFactories(sourceText: string): Map<string, DrizzleMode> {
  const out = new Map<string, DrizzleMode>();
  for (const m of sourceText.matchAll(DRIZZLE_ZOD_RE)) {
    for (const part of m[1]!.split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      const mode = name === "createInsertSchema" ? "insert" : name === "createSelectSchema" ? "select" : name === "createUpdateSchema" ? "update" : null;
      if (mode) out.set((alias ?? name)!.trim(), mode);
    }
  }
  return out;
}

interface Field {
  type: string;
  optional: boolean;
}

/** The zod call chain, innermost first: `z.string().email().optional()` → [string, email, optional]. */
function chainOf(node: Node, ns: ReadonlySet<string>): Array<{ name: string; args: Node[] }> | null {
  const steps: Array<{ name: string; args: Node[] }> = [];
  let n: Node | null = node;
  while (n?.type === "call_expression") {
    const fn = n.childForFieldName("function");
    const args = n.childForFieldName("arguments")?.namedChildren ?? [];
    if (fn?.type !== "member_expression") return null;
    const prop = fn.childForFieldName("property")?.text ?? "";
    steps.unshift({ name: prop, args });
    const obj = fn.childForFieldName("object");
    if (obj?.type === "identifier" && ns.has(obj.text)) return steps;
    n = obj;
  }
  return null;
}

type Dialect = "zod" | "joi";

const literalOf = (v: Node): string | null => (v.type === "string" ? `'${stripQuotes(v.text)}'` : v.type === "number" || v.type === "true" || v.type === "false" ? v.text : null);

class ZodReader {
  readonly classes: ClassInfo[] = [];
  constructor(private readonly ns: ReadonlySet<string>, private readonly dialect: Dialect = "zod") {}

  /** The TypeScript spelling of a schema expression, and whether it is optional. */
  field(node: Node, owner: string): Field {
    if (node.type === "identifier") return { type: node.text, optional: false };
    const chain = chainOf(node, this.ns);
    if (!chain) {
      // A named schema refined further (`addressSchema.optional()`).
      const fn = node.type === "call_expression" ? node.childForFieldName("function") : null;
      const base = fn?.type === "member_expression" ? fn.childForFieldName("object") : null;
      const step = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : undefined;
      if (base && step) {
        const inner = this.field(base, owner);
        return { type: inner.type, optional: inner.optional || step === "optional" || step === "nullish" || step === "default" };
      }
      return { type: "unknown", optional: false };
    }
    const [head, ...mods] = chain;
    if (this.dialect === "joi") return this.joiField(head!, mods, owner);
    const optional = mods.some((m) => m.name === "optional" || m.name === "nullish" || m.name === "default");
    const nullable = mods.some((m) => m.name === "nullable" || m.name === "nullish");
    let type = this.headType(head!, owner);
    if (mods.some((m) => m.name === "array")) type = `${type}[]`;
    return { type: nullable ? `${type} | null` : type, optional };
  }

  /** joi: optional until `.required()`; `.valid(…)` narrows to its values, `.allow(null)` admits null. */
  private joiField(head: { name: string; args: Node[] }, mods: Array<{ name: string; args: Node[] }>, owner: string): Field {
    const optional = !mods.some((m) => m.name === "required" || m.name === "exist");
    const valid = [head, ...mods].filter((m) => m.name === "valid" || m.name === "only" || m.name === "equal").flatMap((m) => m.args.map(literalOf)).filter((v): v is string => v !== null);
    const nullable = mods.some((m) => m.name === "allow" && m.args.some((a) => a.type === "null"));
    let type: string;
    if (valid.length) type = valid.join(" | ");
    else if (head.name === "array") {
      const items = mods.find((m) => m.name === "items")?.args[0];
      type = `${items ? this.field(items, owner).type : "unknown"}[]`;
    } else if (head.name === "object") {
      const obj = head.args[0]?.type === "object" ? head.args[0] : mods.find((m) => m.name === "keys")?.args[0];
      if (obj?.type === "object") {
        this.objectClass(owner, obj, -1);
        type = owner;
      } else type = "Record<string, unknown>";
    } else type = { string: "string", number: "number", boolean: "boolean", bool: "boolean", date: "Date", binary: "string", any: "unknown" }[head.name] ?? "unknown";
    return { type: nullable ? `${type} | null` : type, optional };
  }

  private headType(head: { name: string; args: Node[] }, owner: string): string {
    switch (head.name) {
      case "string": case "uuid": case "email": case "url": case "cuid": return "string";
      case "number": case "bigint": return "number";
      case "boolean": return "boolean";
      case "date": return "Date";
      case "any": case "unknown": return "unknown";
      case "literal": {
        const v = head.args[0];
        return v?.type === "string" ? `'${stripQuotes(v.text)}'` : v?.text ?? "unknown";
      }
      case "enum": {
        const list = head.args[0];
        const values = list?.type === "array" ? list.namedChildren.filter((c) => c.type === "string").map((c) => `'${stripQuotes(c.text)}'`) : [];
        return values.length ? values.join(" | ") : "string";
      }
      case "array": return head.args[0] ? `${this.field(head.args[0], owner).type}[]` : "unknown[]";
      case "record": {
        const value = head.args[head.args.length - 1];
        return `Record<string, ${value ? this.field(value, owner).type : "unknown"}>`;
      }
      case "object": {
        const obj = head.args[0];
        if (obj?.type !== "object") return "unknown";
        this.objectClass(owner, obj, -1);
        return owner;
      }
      default: return "unknown";
    }
  }

  /** A class for one `z.object({ … })` literal, named `name`; nested objects become `name_field`. */
  objectClass(name: string, obj: Node, line: number, base: string | null = null): void {
    const properties: PropertyInfo[] = [];
    for (const pair of obj.namedChildren) {
      if (pair.type !== "pair") continue;
      const key = pair.childForFieldName("key");
      const value = pair.childForFieldName("value");
      if (!key || !value) continue;
      const fieldName = key.type === "string" ? stripQuotes(key.text) : key.text;
      const f = this.field(value, `${name}_${fieldName}`);
      properties.push({ name: fieldName, type: f.type, visibility: "public", isStatic: false, isReadonly: false, ...(f.optional ? {} : { isRequired: true }) });
    }
    const at = line > 0 ? line : obj.startPosition.row + 1;
    this.classes.push({
      name,
      extends: base,
      implements: [],
      decorators: [this.dialect === "joi" ? "joi-schema" : "zod-schema"],
      methods: [],
      properties,
      isExported: false,
      line: at,
      endLine: obj.endPosition.row + 1,
    });
  }
}

/** The object literal a named schema is built from: `z.object({…})`, possibly `.strict()`/`.passthrough()`d. */
function objectLiteralOf(value: Node, ns: ReadonlySet<string>, dialect: Dialect = "zod"): Node | null {
  const chain = chainOf(value, ns);
  if (!chain || chain[0]!.name !== "object") return null;
  const obj = chain[0]!.args[0] ?? (dialect === "joi" ? chain.find((c) => c.name === "keys")?.args[0] : undefined);
  return obj?.type === "object" ? obj : null;
}

/**
 * `postRouter.admin.purge.input`: the procedure an inline `.input(z.object(…))`
 * belongs to, read up through the router object's keys to the binding.
 */
function procedureInputName(inputCall: Node): string | null {
  const keys: string[] = [];
  let n: Node | null = inputCall.parent;
  for (let i = 0; n && i < 40; i++, n = n.parent) {
    if (n.type === "pair") {
      const k = n.childForFieldName("key");
      if (!k) return null;
      keys.unshift(k.type === "string" ? stripQuotes(k.text) : k.text);
    } else if (n.type === "variable_declarator") {
      const owner = n.childForFieldName("name");
      return owner?.type === "identifier" && keys.length > 0 ? `${owner.text}.${keys.join(".")}.input` : null;
    } else if (n.type === "statement_block" || n.type === "program") {
      return null;
    }
  }
  return null;
}

/** Every named zod, joi and drizzle-zod schema in the file, as classes. */
export function extractZodSchemas(root: Node, sourceText: string): ClassInfo[] {
  const out: ClassInfo[] = [];
  if (sourceText.includes("zod")) {
    const ns = zodNamespaces(sourceText);
    if (ns.size > 0) out.push(...readSchemas(root, new ZodReader(ns, "zod"), ns, "zod"));
    const factories = drizzleFactories(sourceText);
    if (factories.size > 0) out.push(...drizzleSchemas(root, factories, ns));
  }
  if (/\bjoi\b|celebrate/.test(sourceText)) {
    const ns = joiNamespaces(sourceText);
    if (ns.size > 0) out.push(...readSchemas(root, new ZodReader(ns, "joi"), ns, "joi"));
  }
  return out;
}

function readSchemas(root: Node, reader: ZodReader, ns: ReadonlySet<string>, dialect: Dialect): ClassInfo[] {
  // How a named schema is extended: zod `base.extend({…})`, joi `base.keys({…})`/`base.append({…})`.
  const EXTEND = dialect === "zod" ? new Set(["extend"]) : new Set(["keys", "append"]);
  const visit = (n: Node): void => {
    // A tRPC procedure's inline input: `.input(z.object({ … }))`.
    if (dialect === "zod" && n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const arg = n.childForFieldName("arguments")?.namedChildren[0];
      const obj = fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "input" && arg ? objectLiteralOf(arg, ns) : null;
      const name = obj ? procedureInputName(n) : null;
      if (obj && name) reader.objectClass(name, obj, n.startPosition.row + 1);
    }
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      const obj = name?.type === "identifier" && value ? objectLiteralOf(value, ns, dialect) : null;
      if (obj) {
        reader.objectClass(name!.text, obj, n.startPosition.row + 1);
        return;
      }
      // `const admin = user.extend({ … })`: the base's fields and these.
      const fn = value?.type === "call_expression" ? value.childForFieldName("function") : null;
      const arg = value?.childForFieldName("arguments")?.namedChildren[0];
      if (name?.type === "identifier" && fn?.type === "member_expression" && EXTEND.has(fn.childForFieldName("property")?.text ?? "") && fn.childForFieldName("object")?.type === "identifier" && !ns.has(fn.childForFieldName("object")!.text) && arg?.type === "object") {
        reader.objectClass(name.text, arg, n.startPosition.row + 1, fn.childForFieldName("object")!.text);
        return;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return reader.classes;
}

// ─── drizzle-zod ────────────────────────────────────────────────────────────

const DRIZZLE_TABLE = /^(?:pg|mysql|sqlite|singlestore)Table$/;
const DRIZZLE_STRING = new Set(["text", "varchar", "char", "uuid", "citext", "inet", "cidr", "macaddr", "macaddr8", "numeric", "decimal", "time", "interval", "longtext", "mediumtext", "tinytext", "binary", "varbinary", "year"]);
const DRIZZLE_NUMBER = new Set(["integer", "int", "int2", "int4", "int8", "smallint", "tinyint", "mediumint", "bigint", "serial", "smallserial", "bigserial", "real", "doublePrecision", "double", "float"]);
const DRIZZLE_DATE = new Set(["timestamp", "date", "datetime"]);
const SERIAL = new Set(["serial", "smallserial", "bigserial"]);
const HAS_DEFAULT = new Set(["default", "defaultNow", "defaultRandom", "$default", "$defaultFn", "$onUpdate", "$onUpdateFn", "generatedByDefaultAsIdentity", "autoincrement"]);
const GENERATED = new Set(["generatedAlwaysAs", "generatedAlwaysAsIdentity"]);

interface DrizzleColumn {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}

/** A column builder chain, innermost first: `text("x").notNull().default("")` → text, notNull, default. */
function columnOf(name: string, value: Node): DrizzleColumn | null {
  const steps: Array<{ name: string; args: Node[] }> = [];
  let n: Node | null = value;
  while (n?.type === "call_expression") {
    const fn: Node | null = n.childForFieldName("function");
    const args = n.childForFieldName("arguments")?.namedChildren ?? [];
    if (fn?.type === "identifier") {
      steps.unshift({ name: fn.text, args });
      break;
    }
    if (fn?.type !== "member_expression") return null;
    const prop = fn.childForFieldName("property")?.text ?? "";
    const obj = fn.childForFieldName("object");
    steps.unshift({ name: prop, args });
    // `t.text()` in the callback form: the builder hangs off the column helper.
    if (obj?.type === "identifier") break;
    n = obj;
  }
  const builder = steps[0];
  if (!builder) return null;
  const mods = steps.slice(1).map((s) => s.name);
  const opts = builder.args.find((a) => a.type === "object")?.text ?? "";
  const stringMode = /\bmode\s*:\s*['"]string['"]/.test(opts);
  const b = builder.name;
  let type = DRIZZLE_STRING.has(b) ? "string" : DRIZZLE_NUMBER.has(b) ? (b === "bigint" && /mode\s*:\s*['"]bigint['"]/.test(opts) ? "bigint" : "number") : b === "boolean" ? "boolean" : DRIZZLE_DATE.has(b) ? (stringMode ? "string" : "Date") : b === "json" || b === "jsonb" ? "unknown" : /Enum$/.test(b) ? "string" : "unknown";
  if (mods.includes("array")) type = `${type}[]`;
  const primary = mods.includes("primaryKey");
  return {
    name,
    type,
    notNull: primary || mods.includes("notNull"),
    hasDefault: SERIAL.has(b) || mods.some((m) => HAS_DEFAULT.has(m)),
    generated: mods.some((m) => GENERATED.has(m)),
  };
}

/** The tables the file declares: `const users = pgTable("users", { … })` or the `(t) => ({ … })` form. */
function drizzleTables(root: Node): Map<string, DrizzleColumn[]> {
  const out = new Map<string, DrizzleColumn[]>();
  const visit = (n: Node): void => {
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      const fn = value?.type === "call_expression" ? value.childForFieldName("function") : null;
      if (name?.type === "identifier" && fn?.type === "identifier" && DRIZZLE_TABLE.test(fn.text)) {
        let cols = value!.childForFieldName("arguments")?.namedChildren[1];
        if (cols?.type === "arrow_function") cols = cols.childForFieldName("body") ?? undefined;
        while (cols?.type === "parenthesized_expression") cols = cols.namedChildren[0];
        if (cols?.type === "object") {
          const columns: DrizzleColumn[] = [];
          for (const pair of cols.namedChildren) {
            const key = pair.type === "pair" ? pair.childForFieldName("key") : null;
            const v = pair.type === "pair" ? pair.childForFieldName("value") : null;
            const c = key && v ? columnOf(key.type === "string" ? stripQuotes(key.text) : key.text, v) : null;
            if (c) columns.push(c);
          }
          out.set(name.text, columns);
        }
        return;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return out;
}

/** `true`-valued keys of an object literal: `.omit({ id: true, createdAt: true })`. */
const maskKeys = (obj: Node | undefined): Set<string> => new Set((obj?.type === "object" ? obj.namedChildren : []).filter((p) => p.type === "pair").map((p) => p.childForFieldName("key")!).map((k) => (k.type === "string" ? stripQuotes(k.text) : k.text)));

function drizzleSchemas(root: Node, factories: ReadonlyMap<string, DrizzleMode>, zodNs: ReadonlySet<string>): ClassInfo[] {
  const tables = drizzleTables(root);
  if (tables.size === 0) return [];
  const reader = new ZodReader(zodNs, "zod");
  const out: ClassInfo[] = [];
  const visit = (n: Node): void => {
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      // Unwind `.omit(…)`/`.pick(…)`/`.extend(…)`/`.partial()` down to the factory call.
      const tail: Array<{ name: string; args: Node[] }> = [];
      let cur: Node | null | undefined = value;
      while (cur?.type === "call_expression") {
        const fn: Node | null = cur.childForFieldName("function");
        const args = cur.childForFieldName("arguments")?.namedChildren ?? [];
        if (fn?.type === "identifier") {
          const mode = factories.get(fn.text);
          const table = args[0]?.type === "identifier" ? tables.get(args[0].text) : undefined;
          if (name?.type === "identifier" && mode && table) out.push(drizzleClass(name.text, n, mode, table, args[1], tail, reader));
          return;
        }
        if (fn?.type !== "member_expression") break;
        tail.unshift({ name: fn.childForFieldName("property")?.text ?? "", args });
        cur = fn.childForFieldName("object");
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return [...out, ...reader.classes];
}

function drizzleClass(name: string, decl: Node, mode: DrizzleMode, table: readonly DrizzleColumn[], refine: Node | undefined, tail: ReadonlyArray<{ name: string; args: Node[] }>, reader: ZodReader): ClassInfo {
  // A refinement that is a zod schema replaces the column's type; a callback (`(s) => s.email()`) keeps it.
  const refined = new Map<string, string>();
  for (const pair of refine?.type === "object" ? refine.namedChildren : []) {
    const key = pair.type === "pair" ? pair.childForFieldName("key") : null;
    const v = pair.type === "pair" ? pair.childForFieldName("value") : null;
    if (key && v && v.type !== "arrow_function" && v.type !== "function_expression") refined.set(key.type === "string" ? stripQuotes(key.text) : key.text, reader.field(v, `${name}_${key.text}`).type);
  }
  let properties: PropertyInfo[] = table
    .filter((c) => !(mode !== "select" && c.generated))
    .map((c) => {
      const required = mode === "select" ? true : mode === "insert" ? c.notNull && !c.hasDefault : false;
      const type = refined.get(c.name) ?? c.type;
      return { name: c.name, type: c.notNull ? type : `${type} | null`, visibility: "public" as const, isStatic: false, isReadonly: false, ...(required ? { isRequired: true } : {}) };
    });
  for (const step of tail) {
    if (step.name === "omit") {
      const drop = maskKeys(step.args[0]);
      properties = properties.filter((p) => !drop.has(p.name));
    } else if (step.name === "pick") {
      const keep = maskKeys(step.args[0]);
      properties = properties.filter((p) => keep.has(p.name));
    } else if (step.name === "partial") {
      properties = properties.map(({ isRequired: _, ...p }) => p);
    } else if (step.name === "required") {
      properties = properties.map((p) => ({ ...p, isRequired: true }));
    } else if (step.name === "extend" && step.args[0]?.type === "object") {
      for (const pair of step.args[0].namedChildren) {
        const key = pair.type === "pair" ? pair.childForFieldName("key") : null;
        const v = pair.type === "pair" ? pair.childForFieldName("value") : null;
        if (!key || !v) continue;
        const fieldName = key.type === "string" ? stripQuotes(key.text) : key.text;
        const f = reader.field(v, `${name}_${fieldName}`);
        properties = [...properties.filter((p) => p.name !== fieldName), { name: fieldName, type: f.type, visibility: "public", isStatic: false, isReadonly: false, ...(f.optional ? {} : { isRequired: true }) }];
      }
    }
  }
  return {
    name,
    extends: null,
    implements: [],
    decorators: ["zod-schema", `drizzle-zod:${mode}`],
    methods: [],
    properties,
    isExported: false,
    line: decl.startPosition.row + 1,
    endLine: decl.endPosition.row + 1,
  };
}
