import type { PropertyInfo } from "../../../types/analysis.js";
import type { RequestSchemaHooks, TypeShape } from "../../../types/language-plugin.js";
import { bindPhpParam } from "./request-access.js";

/**
 * How PHP types and properties look on the wire — Symfony's Serializer
 * (`#[MapRequestPayload]` DTOs), Laravel's `FormRequest` and plain
 * `json_encode`d value objects all agree on the basics: public properties
 * by their declared name, scalars as JSON scalars, `array` as a list of
 * anything, and a class name as a nested object. Consumed by the
 * language-agnostic request-schema pass; nothing here walks classes.
 *
 * Property types arrive as the function extractor stored them: a nullable
 * property keeps its leading `?` (`?Address`), a union keeps `|null`.
 */

const SCALARS: Record<string, { type: "string" | "integer" | "number" | "boolean"; format?: string }> = {
  string: { type: "string" },
  int: { type: "integer" },
  integer: { type: "integer" },
  float: { type: "number" },
  double: { type: "number" },
  bool: { type: "boolean" },
  boolean: { type: "boolean" },
  false: { type: "boolean" },
  true: { type: "boolean" },
  DateTimeInterface: { type: "string", format: "date-time" },
  DateTime: { type: "string", format: "date-time" },
  DateTimeImmutable: { type: "string", format: "date-time" },
  Carbon: { type: "string", format: "date-time" },
  CarbonImmutable: { type: "string", format: "date-time" },
  CarbonInterface: { type: "string", format: "date-time" },
  Uuid: { type: "string", format: "uuid" },
  UuidInterface: { type: "string", format: "uuid" },
  Ulid: { type: "string" },
  Stringable: { type: "string" },
  UploadedFile: { type: "string", format: "binary" },
};

const ANY_TYPES: ReadonlySet<string> = new Set(["mixed", "object", "stdClass", "null", "void", "never", "callable", "Closure"]);
const ARRAY_TYPES: ReadonlySet<string> = new Set(["array", "iterable", "Collection", "EloquentCollection", "ArrayCollection", "Traversable", "Generator", "list"]);

/** Drop the namespace (`App\Dto\Foo` → `Foo`) and a leading `\`. */
function simpleName(type: string): string {
  return type.replace(/^\\/, "").replace(/.*\\/, "").trim();
}

/** `array<int, Foo>` / `list<Foo>` / `Collection<Foo>` → `Foo`; `Foo[]` → `Foo`; a plain `array` → `mixed`. */
function elementOf(type: string): string {
  if (type.endsWith("[]")) return type.slice(0, -2);
  const m = type.match(/^[\w\\]+<(.+)>$/);
  if (!m) return "mixed";
  const args = m[1]!.split(",").map((a) => a.trim());
  return args[args.length - 1] || "mixed";
}

/** First string argument of a matching attribute: `SerializedName('x')` → `x`; `Assert\NotBlank` matches by simple name. */
function decoratorString(decorators: readonly string[] | undefined, names: readonly string[]): string | null {
  for (const d of decorators ?? []) {
    const m = d.match(/^(?:[\w\\]+\\)?(\w+)\s*\((.*)\)\s*$/s);
    if (!m || !names.includes(m[1]!)) continue;
    const str = m[2]!.match(/(['"])([^'"]*)\1/);
    if (str) return str[2]!;
  }
  return null;
}

function hasDecorator(decorators: readonly string[] | undefined, names: readonly string[]): boolean {
  return (decorators ?? []).some((d) => {
    const m = d.match(/^(?:[\w\\]+\\)?(\w+)(?:\s*\(|$)/);
    return !!m && names.includes(m[1]!);
  });
}

export const phpRequestSchema: RequestSchemaHooks = {
  bindParam(param, route) {
    return bindPhpParam(param.name, param.type, route.path);
  },

  unwrapNullable(type) {
    let t = type.trim();
    let nullable = false;
    if (t.startsWith("?")) {
      t = t.slice(1).trim();
      nullable = true;
    }
    // `Foo|null` / `null|Foo` — a nullable union; other unions stay as they are.
    const members = t.split("|").map((m) => m.trim());
    if (members.length > 1 && members.some((m) => m.toLowerCase() === "null")) {
      nullable = true;
      const rest = members.filter((m) => m.toLowerCase() !== "null");
      t = rest.join("|");
    }
    return { type: t, nullable };
  },

  describeType(type): TypeShape {
    const t = type.trim();
    if (t.endsWith("[]")) return { kind: "array", element: t.slice(0, -2) };
    const generic = t.match(/^([\w\\]+)<(.+)>$/);
    const name = simpleName(generic ? generic[1]! : t);
    if (ARRAY_TYPES.has(name)) return { kind: "array", element: elementOf(t) };
    if (!generic) {
      const scalar = SCALARS[name];
      if (scalar) return { kind: "scalar", schema: { ...scalar } };
      if (ANY_TYPES.has(name) || t.includes("|")) return { kind: "any" };
    }
    return { kind: "object", name: t };
  },

  serializedName(prop: PropertyInfo) {
    return decoratorString(prop.decorators, ["SerializedName", "JsonProperty", "MapName", "SerializedPath"]) ?? prop.name;
  },

  isSerialized(prop: PropertyInfo) {
    if (prop.isStatic) return false;
    if (prop.visibility !== "public") return false;
    if (hasDecorator(prop.decorators, ["Ignore", "JsonIgnore", "Hidden"])) return false;
    return true;
  },

  isRequired(prop: PropertyInfo) {
    return prop.isRequired === true || hasDecorator(prop.decorators, ["NotBlank", "NotNull", "Required"]);
  },
};
