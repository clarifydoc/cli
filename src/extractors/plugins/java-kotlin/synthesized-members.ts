import type { Node } from "web-tree-sitter";
import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";

/**
 * Members the compiler or a code generator gives a JVM class from what it
 * declares, with the return types a call chain continues through:
 *
 * - a Java `record Grid(Engine engine)`: the accessor `engine()`;
 * - a Kotlin `data class Lap(val bay: Bay)`: `copy(…)` (every property, each
 *   optional) and `component1()`…;
 * - Lombok: `@Getter` / `@Setter` on the class or a field, `@Data` (getters,
 *   setters for non-final fields), `@Value` (getters), `@With`, `@Accessors`
 *   (`fluent`, `chain`) and `@Builder` — `Car.builder()` returning the
 *   `CarBuilder` class, whose setters are named after the fields and whose
 *   `build()` returns `Car`.
 *
 * Each is marked `synthetic` and points at the line it is generated from (the
 * field or record component, else the class). A member the class writes
 * itself (same name, same arity) is never shadowed.
 */

const ANN = (name: string) => new RegExp(`^(?:lombok\\.(?:experimental\\.)?)?${name}(?:\\s*\\(|$)`);
const GETTER = ANN("Getter");
const SETTER = ANN("Setter");
const DATA = ANN("Data");
const VALUE = ANN("Value");
const BUILDER = ANN("(?:Super)?Builder");
const WITH = ANN("With");
const ACCESSORS = ANN("Accessors");

const find = (decorators: readonly string[] | undefined, re: RegExp): string | undefined => decorators?.find((d) => re.test(d.trim()));

/** An annotation switched off: `@Getter(AccessLevel.NONE)`. */
const isNone = (ann: string): boolean => /AccessLevel\.NONE\b/.test(ann);

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function synthetic(name: string, params: ParamInfo[], returnType: string | null, line: number): FunctionInfo {
  return {
    name,
    params,
    returnType,
    isAsync: false,
    isExported: true,
    decorators: [],
    calls: [],
    line,
    endLine: line,
    synthetic: true,
  };
}

/** Adds `fn` unless the class writes a member of that name and arity itself. */
function addUnlessWritten(methods: FunctionInfo[], fn: FunctionInfo): void {
  const arity = fn.params.length;
  if (methods.some((m) => m.name === fn.name && m.params.filter((p) => !p.isReceiver).length === arity)) return;
  methods.push(fn);
}

/** The line each field (Java `field_declaration`) or record component is declared on, by name. */
export function memberLines(classNode: Node, body: Node | null): Map<string, number> {
  const lines = new Map<string, number>();
  if (classNode.type === "record_declaration") {
    const params = classNode.childForFieldName("parameters");
    for (const p of params?.namedChildren ?? []) {
      const name = p.childForFieldName("name");
      if (name) lines.set(name.text, name.startPosition.row + 1);
    }
  }
  for (const member of body?.namedChildren ?? []) {
    if (member.type !== "field_declaration") continue;
    for (const d of member.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      // The declarator's line, below any annotations on the field.
      const name = d.childForFieldName("name");
      if (name) lines.set(name.text, name.startPosition.row + 1);
    }
  }
  return lines;
}

/** Java: record accessors and Lombok members onto `cls`; the Lombok builder class, when `@Builder` asks for one the class does not write. */
export function synthesizeJavaMembers(classNode: Node, cls: ClassInfo, body: Node | null, nestedClassNames: ReadonlySet<string>): ClassInfo | null {
  const lines = memberLines(classNode, body);
  const classLine = cls.line;
  // Instance fields only (an enum's constants are static).
  const fields = cls.properties.filter((p) => !p.isStatic);
  const lineOf = (p: PropertyInfo): number => lines.get(p.name) ?? classLine;
  const isRecord = classNode.type === "record_declaration";

  if (isRecord) {
    for (const p of fields) addUnlessWritten(cls.methods, synthetic(p.name, [], p.type, lineOf(p)));
  }

  const decorators = cls.decorators;
  const data = find(decorators, DATA);
  const value = find(decorators, VALUE);
  const classGetter = find(decorators, GETTER);
  const classSetter = find(decorators, SETTER);
  const classWith = find(decorators, WITH);
  const accessors = find(decorators, ACCESSORS);
  const fluent = !!accessors && /\bfluent\s*=\s*true\b/.test(accessors);
  const chain = fluent || (!!accessors && /\bchain\s*=\s*true\b/.test(accessors));

  for (const p of isRecord ? [] : fields) {
    const own = p.decorators ?? [];
    const getter = find(own, GETTER) ?? classGetter ?? data ?? value;
    const setter = find(own, SETTER) ?? classSetter ?? data;
    const wither = find(own, WITH) ?? classWith;
    const line = lineOf(p);
    const bare = /^is[A-Z]/.test(p.name) && p.type === "boolean" ? p.name.slice(2) : p.name;
    if (getter && !isNone(getter)) {
      const name = fluent ? p.name : p.type === "boolean" ? (bare === p.name ? `is${capitalize(p.name)}` : p.name) : `get${capitalize(p.name)}`;
      addUnlessWritten(cls.methods, synthetic(name, [], p.type, line));
    }
    // A final field has no setter (and every field of a `@Value` class is final).
    if (setter && !isNone(setter) && !p.isReadonly && !value) {
      const name = fluent ? p.name : `set${capitalize(bare)}`;
      addUnlessWritten(cls.methods, synthetic(name, [{ name: p.name, type: p.type, defaultValue: null }], chain ? cls.name : "void", line));
    }
    if (wither && !isNone(wither)) {
      addUnlessWritten(cls.methods, synthetic(`with${capitalize(bare)}`, [{ name: p.name, type: p.type, defaultValue: null }], cls.name, line));
    }
  }

  const builder = find(decorators, BUILDER);
  if (!builder) return null;
  const builderName = /\bbuilderClassName\s*=\s*"(\w+)"/.exec(builder)?.[1] ?? `${cls.name}Builder`;
  const builderMethod = /\bbuilderMethodName\s*=\s*"(\w+)"/.exec(builder)?.[1] ?? "builder";
  const buildMethod = /\bbuildMethodName\s*=\s*"(\w+)"/.exec(builder)?.[1] ?? "build";
  addUnlessWritten(cls.methods, synthetic(builderMethod, [], builderName, classLine));
  if (/\btoBuilder\s*=\s*true\b/.test(builder)) addUnlessWritten(cls.methods, synthetic("toBuilder", [], builderName, classLine));
  // A builder class the source writes itself is completed by Lombok; its written members stand.
  if (nestedClassNames.has(builderName)) return null;
  const methods: FunctionInfo[] = [];
  for (const p of fields) methods.push(synthetic(p.name, [{ name: p.name, type: p.type, defaultValue: null }], builderName, lineOf(p)));
  methods.push(synthetic(buildMethod, [], cls.name, classLine));
  return {
    name: builderName,
    synthetic: true,
    kind: "class",
    extends: null,
    implements: [],
    decorators: [],
    methods,
    properties: [],
    isExported: cls.isExported,
    line: classLine,
    endLine: classLine,
  };
}

/** Kotlin `data class`: `copy(…)` with every property optional, and `componentN()` for each in order. */
export function synthesizeKotlinDataMembers(classNode: Node, cls: ClassInfo): void {
  const modifiers = classNode.namedChildren.find((c) => c.type === "modifiers");
  if (!modifiers?.namedChildren.some((m) => m.type === "class_modifier" && m.text === "data")) return;
  const ctor = classNode.namedChildren.find((c) => c.type === "primary_constructor");
  const props: Array<{ name: string; type: string | null; line: number }> = [];
  for (const p of ctor?.namedChildren ?? []) {
    if (p.type !== "class_parameter") continue;
    const name = p.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) continue;
    props.push({ name, type: cls.properties.find((q) => q.name === name)?.type ?? null, line: p.startPosition.row + 1 });
  }
  if (props.length === 0) return;
  const self = cls.name;
  addUnlessWritten(cls.methods, synthetic("copy", props.map((p) => ({ name: p.name, type: p.type, defaultValue: p.name })), self, cls.line));
  props.forEach((p, i) => addUnlessWritten(cls.methods, synthetic(`component${i + 1}`, [], p.type, p.line)));
}
