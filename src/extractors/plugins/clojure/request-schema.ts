import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Malli (`int?`, `:string`, `[:vector T]`) and Plumatic Schema (`s/Int`,
 * `[s/Str]`, `{s/Keyword s/Str}`) type texts serialize as JSON. Property
 * type texts are the printed schema forms the class extractor stored, so the
 * hooks read those spellings back. Records carry `type: null` — untyped.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  // Malli predicates and keyword schemas
  "int?": { type: "integer" }, "integer?": { type: "integer" }, "pos-int?": { type: "integer" }, "nat-int?": { type: "integer" }, "neg-int?": { type: "integer" },
  ":int": { type: "integer" },
  "string?": { type: "string" }, ":string": { type: "string" }, "keyword?": { type: "string" }, ":keyword": { type: "string" },
  "boolean?": { type: "boolean" }, ":boolean": { type: "boolean" },
  "double?": { type: "number", format: "double" }, ":double": { type: "number", format: "double" }, "float?": { type: "number", format: "float" },
  "number?": { type: "number" }, "decimal?": { type: "number" },
  "uuid?": { type: "string", format: "uuid" }, ":uuid": { type: "string", format: "uuid" },
  "inst?": { type: "string", format: "date-time" }, ":inst": { type: "string", format: "date-time" },
  // Plumatic Schema
  "s/Int": { type: "integer" }, "s/Str": { type: "string" }, "s/Bool": { type: "boolean" }, "s/Num": { type: "number" },
  "s/Keyword": { type: "string" }, "s/Uuid": { type: "string", format: "uuid" }, "s/Inst": { type: "string", format: "date-time" },
  "schema.core/Int": { type: "integer" }, "schema.core/Str": { type: "string" }, "schema.core/Bool": { type: "boolean" }, "schema.core/Num": { type: "number" },
  "Long": { type: "integer" }, "String": { type: "string" }, "Boolean": { type: "boolean" }, "Double": { type: "number", format: "double" },
};

const ANY = new Set(["any?", ":any", "s/Any", "schema.core/Any", "map?", ":map", "some?"]);

/** `[:vector T]` / `[:sequential T]` / `[:set T]` / `[:maybe T]` / `[:map-of K V]` → head + args, as printed forms. */
function vectorSchema(text: string): { head: string; args: string[] } | null {
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  if (parts.length === 0) return null;
  // Drop a properties map (`[:vector {:min 1} int?]`).
  const args = parts.slice(1).filter((p) => !p.startsWith("{"));
  return { head: parts[0]!, args };
}

export const clojureRequestSchema: RequestSchemaHooks = {
  bindParam(param) {
    if (/^(?:req|request|ctx|context)$/.test(param.name)) return "services";
    return null;
  },

  unwrapNullable(type) {
    const t = type.trim();
    const v = vectorSchema(t);
    if (v && v.head === ":maybe" && v.args[0]) return { type: v.args[0], nullable: true };
    const maybe = t.match(/^\(s\/maybe\s+(.+)\)$/);
    if (maybe) return { type: maybe[1]!, nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    const v = vectorSchema(t);
    if (v) {
      if ((v.head === ":vector" || v.head === ":sequential" || v.head === ":set") && v.args[0]) return { kind: "array", element: v.args[0] };
      if (v.head === ":map-of" && v.args[1]) return { kind: "map", value: v.args[1] };
      if (v.head === ":map") return { kind: "any" };
      if (v.head === ":enum") return { kind: "scalar", schema: { type: "string" } };
      if (v.head === ":ref" && v.args[0]) return { kind: "object", name: v.args[0].replace(/^:/, "") };
      // Plumatic `[s/Str]` — a sequence of the element schema.
      if (v.args.length === 0 && !v.head.startsWith(":")) return { kind: "array", element: v.head };
    }
    if (t.startsWith("{") && t.endsWith("}")) {
      const m = t.match(/^\{\s*(\S+)\s+(.+)\}$/);
      if (m && /^s\/\w+|Keyword|Str$/.test(m[1]!)) return { kind: "map", value: m[2]!.trim() };
      return { kind: "any" };
    }
    const scalar = SCALARS[t];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (ANY.has(t)) return { kind: "any" };
    if (t.startsWith("(s/enum") || t.startsWith("(schema.core/enum")) return { kind: "scalar", schema: { type: "string" } };
    // A capitalised symbol names another schema / record in the project.
    return { kind: "object", name: t.replace(/^.*\//, "") };
  },

  serializedName(prop: PropertyInfo) {
    return prop.name;
  },

  isSerialized() {
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
