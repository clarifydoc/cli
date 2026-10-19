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
 * `base.extend({ … })` a class that extends `base`. The
 * request-schema pass then flattens a body typed by the schema's name with
 * the TypeScript hooks, as it does any class. Only a schema bound to a name
 * (`const x = z.object(…)`, possibly `.strict()`ed, or `y.extend(…)`) is read;
 * the binding never joins a handler by its text — a route names the schema
 * it validates with (`schema.parse(req.body)`, `validate(schema)`,
 * `.input(schema)`).
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

class ZodReader {
  readonly classes: ClassInfo[] = [];
  constructor(private readonly ns: ReadonlySet<string>) {}

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
    const optional = mods.some((m) => m.name === "optional" || m.name === "nullish" || m.name === "default");
    const nullable = mods.some((m) => m.name === "nullable" || m.name === "nullish");
    let type = this.headType(head!, owner);
    if (mods.some((m) => m.name === "array")) type = `${type}[]`;
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
      decorators: ["zod-schema"],
      methods: [],
      properties,
      isExported: false,
      line: at,
      endLine: obj.endPosition.row + 1,
    });
  }
}

/** The object literal a named schema is built from: `z.object({…})`, possibly `.strict()`/`.passthrough()`d. */
function objectLiteralOf(value: Node, ns: ReadonlySet<string>): Node | null {
  const chain = chainOf(value, ns);
  if (!chain || chain[0]!.name !== "object") return null;
  const obj = chain[0]!.args[0];
  return obj?.type === "object" ? obj : null;
}

/** Every `const x = z.object({ … })` in the file, as classes. */
export function extractZodSchemas(root: Node, sourceText: string): ClassInfo[] {
  if (!sourceText.includes("zod")) return [];
  const ns = zodNamespaces(sourceText);
  if (ns.size === 0) return [];
  const reader = new ZodReader(ns);
  const visit = (n: Node): void => {
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      const obj = name?.type === "identifier" && value ? objectLiteralOf(value, ns) : null;
      if (obj) {
        reader.objectClass(name!.text, obj, n.startPosition.row + 1);
        return;
      }
      // `const admin = user.extend({ … })`: the base's fields and these.
      const fn = value?.type === "call_expression" ? value.childForFieldName("function") : null;
      const arg = value?.childForFieldName("arguments")?.namedChildren[0];
      if (name?.type === "identifier" && fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "extend" && fn.childForFieldName("object")?.type === "identifier" && arg?.type === "object") {
        reader.objectClass(name.text, arg, n.startPosition.row + 1, fn.childForFieldName("object")!.text);
        return;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(root);
  return reader.classes;
}
