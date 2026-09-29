import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";

/**
 * How Moose/Moo attribute types (`isa => 'Str'`, `'ArrayRef[Item]'`,
 * `'Maybe[Int]'`) serialize under JSON::MaybeXS. Perl has no static types
 * beyond these constraint strings, so this is the whole typed surface. The
 * language-agnostic request-schema pass owns the recursion; these hooks say
 * what one type text means and what one attribute is called on the wire.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  Str: { type: "string" },
  Int: { type: "integer" },
  Num: { type: "number" },
  Bool: { type: "boolean" },
  Value: { type: "string" },
  ClassName: { type: "string" },
  RoleName: { type: "string" },
  FileHandle: { type: "string" },
  "DateTime": { type: "string", format: "date-time" },
  "Path::Tiny": { type: "string" },
};

const ANY_TYPES = new Set(["Any", "Item", "Defined", "Ref", "ScalarRef", "CodeRef", "Object", "Undef", "Str|Undef"]);

/** `ArrayRef[Item]` → `{ name: "ArrayRef", arg: "Item" }`; `Str` → `{ name: "Str", arg: null }`. */
function splitParam(type: string): { name: string; arg: string | null } {
  const m = type.match(/^([\w:]+)\s*\[(.*)\]$/s);
  return m ? { name: m[1]!, arg: m[2]!.trim() } : { name: type, arg: null };
}

export const perlRequestSchema: RequestSchemaHooks = {
  bindParam(param) {
    // Catalyst passes `$c` (and `$self`) positionally; a Mojolicious action gets `$c` too.
    if (param.name === "c" || param.name === "self" || param.name === "app") return "services";
    return null;
  },

  unwrapNullable(type) {
    const t = type.trim();
    const p = splitParam(t);
    if (p.name === "Maybe" && p.arg) return { type: p.arg, nullable: true };
    if (/\|\s*Undef$/.test(t)) return { type: t.replace(/\s*\|\s*Undef$/, ""), nullable: true };
    return { type: t, nullable: false };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    const p = splitParam(t);
    if (p.arg !== null) {
      if (p.name === "ArrayRef") return { kind: "array", element: p.arg };
      if (p.name === "HashRef") return { kind: "map", value: p.arg };
      if (p.name === "InstanceOf" || p.name === "Maybe") return { kind: "object", name: p.arg.replace(/^['"]|['"]$/g, "") };
    }
    if (p.name === "ArrayRef") return { kind: "array", element: "Any" };
    if (p.name === "HashRef") return { kind: "map", value: "Any" };
    const scalar = SCALARS[p.name];
    if (scalar) return { kind: "scalar", schema: { ...scalar } };
    if (ANY_TYPES.has(p.name)) return { kind: "any" };
    // A class name (`User`, `My::App::Item`) — the full package name, which is how the class is keyed.
    return { kind: "object", name: p.name };
  },

  serializedName(prop: PropertyInfo) {
    return prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    // Moose attributes are public unless named with the private-by-convention underscore.
    return !prop.name.startsWith("_") && !prop.isStatic;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true;
  },
};
