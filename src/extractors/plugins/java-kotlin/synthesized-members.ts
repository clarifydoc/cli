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
 *   `build()` returns `Car`; `@Singular` adds the one-element setter (`player(x)` beside `players(…)`), and a
 *   `@Builder` on a constructor or a static method builds that member's parameters.
 *
 * - an enum (either language): the static `values()` (an array of the enum) and `valueOf(String)`, so
 *   `Position.valueOf(s).label()` types through and the namesake `valueOf` of an unrelated class is never the answer.
 *
 * - AutoValue: the generated `AutoValue_Club`, a subclass of the abstract value class, so `new AutoValue_Club(…)`
 *   continues through the members it inherits;
 * - Immutables (`@Value.Immutable`): `ImmutableClub` with `builder()`, `copyOf(…)`, `withX(…)` and its `Builder`
 *   (one setter per attribute, `build()` returning the value class).
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
const SINGULAR = ANN("Singular");

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
export function synthesizeJavaMembers(classNode: Node, cls: ClassInfo, body: Node | null, nestedClassNames: ReadonlySet<string>): ClassInfo[] {
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
  if (!builder) return memberBuilders(cls, staticMethodNames(body));
  const builderName = /\bbuilderClassName\s*=\s*"(\w+)"/.exec(builder)?.[1] ?? `${cls.name}Builder`;
  const builderMethod = /\bbuilderMethodName\s*=\s*"(\w+)"/.exec(builder)?.[1] ?? "builder";
  const buildMethod = /\bbuildMethodName\s*=\s*"(\w+)"/.exec(builder)?.[1] ?? "build";
  addUnlessWritten(cls.methods, synthetic(builderMethod, [], builderName, classLine));
  if (/\btoBuilder\s*=\s*true\b/.test(builder)) addUnlessWritten(cls.methods, synthetic("toBuilder", [], builderName, classLine));
  // A builder class the source writes itself is completed by Lombok; its written members stand.
  if (nestedClassNames.has(builderName)) return [];
  const methods: FunctionInfo[] = [];
  for (const p of fields) {
    methods.push(synthetic(p.name, [{ name: p.name, type: p.type, defaultValue: null }], builderName, lineOf(p)));
    const single = singularOf(p);
    if (single) methods.push(synthetic(single.name, [{ name: single.name, type: single.type, defaultValue: null }], builderName, lineOf(p)));
  }
  methods.push(synthetic(buildMethod, [], cls.name, classLine));
  return [builderClass(builderName, methods, cls)];
}

const SINGULAR_TYPES = /^(?:(?:java\.util\.)?(?:List|Set|Collection|SortedSet|NavigableSet)|(?:com\.google\.common\.collect\.)?Immutable(?:List|Set|Collection|SortedSet))<\s*([^<>,]+(?:<[^<>]*>)?)\s*>$/;

/** The one-element setter Lombok adds for a `@Singular` collection field: its name (`players` → `player`) and element type. */
function singularOf(p: PropertyInfo): { name: string; type: string } | null {
  const ann = find(p.decorators, SINGULAR);
  const type = p.type ? SINGULAR_TYPES.exec(p.type.trim())?.[1]?.trim() : undefined;
  if (!ann || !type) return null;
  const given = /\(\s*(?:value\s*=\s*)?"(\w+)"/.exec(ann)?.[1];
  if (given) return { name: given, type };
  // Lombok's own English rule for the common plurals; a name it cannot singularize is a compile error there.
  const n = p.name;
  const name = /ies$/.test(n) ? `${n.slice(0, -3)}y` : /(?:ss|us)$/.test(n) || !/s$/.test(n) ? null : n.slice(0, -1);
  return name ? { name, type } : null;
}

function staticMethodNames(body: Node | null): Set<string> {
  const names = new Set<string>();
  for (const m of body?.namedChildren ?? []) {
    if (m.type !== "method_declaration") continue;
    const mods = m.namedChildren.find((c) => c.type === "modifiers")?.children.filter((c) => c.type !== "annotation" && c.type !== "marker_annotation").map((c) => c.text) ?? [];
    const name = m.childForFieldName("name")?.text;
    if (name && mods.includes("static")) names.add(name);
  }
  return names;
}

function builderClass(name: string, methods: FunctionInfo[], cls: ClassInfo): ClassInfo {
  return {
    name,
    synthetic: true,
    kind: "class",
    extends: null,
    implements: [],
    decorators: [],
    methods,
    properties: [],
    isExported: cls.isExported,
    line: cls.line,
    endLine: cls.line,
  };
}

/**
 * `@Builder` on a constructor or a static method (never beside a class-level one): the builder method is the
 * class's own, the builder class takes that member's parameters, and `build()` returns the class (constructor) or
 * the method's return type.
 */
function memberBuilders(cls: ClassInfo, staticNames: ReadonlySet<string>): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (const m of cls.methods.filter((x) => !x.synthetic)) {
    const ann = find(m.decorators, BUILDER);
    // A Java constructor is named for its class and states no return type.
    const isCtor = m.returnType === null && (m.name === cls.name || m.name === "constructor");
    if (!ann || (!isCtor && !staticNames.has(m.name))) continue;
    const result = isCtor ? cls.name : m.returnType;
    if (!result || result === "void") continue;
    const builderName = /\bbuilderClassName\s*=\s*"(\w+)"/.exec(ann)?.[1] ?? `${result.replace(/<.*$/, "")}Builder`;
    const builderMethod = /\bbuilderMethodName\s*=\s*"(\w+)"/.exec(ann)?.[1] ?? "builder";
    const buildMethod = /\bbuildMethodName\s*=\s*"(\w+)"/.exec(ann)?.[1] ?? "build";
    addUnlessWritten(cls.methods, synthetic(builderMethod, [], builderName, m.line));
    const methods = m.params.filter((p) => !p.isReceiver).map((p) => synthetic(p.name, [{ name: p.name, type: p.type, defaultValue: null }], builderName, m.line));
    methods.push(synthetic(buildMethod, [], result, m.line));
    out.push(builderClass(builderName, methods, cls));
  }
  return out;
}

/**
 * The accessors Java sees on a Kotlin class's properties: `getName()` / `setPoints(…)`, and `isActive()` for a
 * Boolean named `isActive` (its setter `setActive`). Only what the property declaration implies — a private property
 * has none, a `@JvmField` is a field — and never a member the class writes itself.
 */
export function synthesizeKotlinAccessors(cls: ClassInfo): void {
  for (const p of cls.properties) {
    if (p.isStatic || p.visibility === "private" || p.decorators?.some((d) => /^JvmField\b/.test(d.replace(/^@/, "").trim()))) continue;
    const isFlag = p.type === "Boolean" && /^is[A-Z]/.test(p.name);
    addUnlessWritten(cls.methods, synthetic(isFlag ? p.name : `get${capitalize(p.name)}`, [], p.type, cls.line));
    if (!p.isReadonly) {
      addUnlessWritten(cls.methods, synthetic(`set${capitalize(isFlag ? p.name.slice(2) : p.name)}`, [{ name: p.name, type: p.type, defaultValue: null }], "Unit", cls.line));
    }
  }
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

/**
 * `values()` and `valueOf(String)` of an enum. Kotlin states the array as `Array<X>`, Java as `X[]`; the call is made
 * on the enum's own name, so it needs the member on the class — a class naming it elsewhere never answers it.
 */
export function synthesizeEnumMembers(cls: ClassInfo, lang: "java" | "kotlin"): void {
  if (cls.kind !== "enum") return;
  addUnlessWritten(cls.methods, synthetic("values", [], lang === "kotlin" ? `Array<${cls.name}>` : `${cls.name}[]`, cls.line));
  addUnlessWritten(cls.methods, synthetic("valueOf", [{ name: "name", type: "String", defaultValue: null }], cls.name, cls.line));
}

const AUTO_VALUE = ANN("AutoValue");
const IMMUTABLE = /^(?:org\.immutables\.value\.)?Value\.Immutable(?:\s*\(|$)/;

/** The class a generated type is, with no members of its own beyond `methods`. */
function generatedClass(name: string, base: ClassInfo, extendsName: string | null, implementsList: string[], methods: FunctionInfo[]): ClassInfo {
  return {
    name,
    synthetic: true,
    kind: "class",
    extends: extendsName,
    implements: implementsList,
    decorators: [],
    methods,
    properties: [],
    isExported: base.isExported,
    line: base.line,
    endLine: base.line,
  };
}

/** The abstract no-argument accessors of a value type: the attributes a generator reads. */
function valueAttributes(body: Node | null): Array<{ name: string; type: string | null; line: number; parameter: boolean }> {
  const out: Array<{ name: string; type: string | null; line: number; parameter: boolean }> = [];
  for (const m of body?.namedChildren ?? []) {
    if (m.type !== "method_declaration" || m.childForFieldName("body")) continue;
    if (m.childForFieldName("parameters")?.namedChildren.length) continue;
    const mods = m.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
    const type = m.childForFieldName("type")?.text ?? null;
    const name = m.childForFieldName("name")?.text;
    if (!name || !type || type === "void" || /\bstatic\b/.test(mods)) continue;
    out.push({ name, type, line: m.startPosition.row + 1, parameter: /@(?:org\.immutables\.value\.)?Value\.Parameter\b/.test(mods) });
  }
  return out;
}

/**
 * Java: the class AutoValue or Immutables generates beside an annotated abstract class or interface. The
 * generated source is usually not in the tree (`target/`).
 */
export function synthesizeGeneratedValueClasses(classNode: Node, cls: ClassInfo, body: Node | null): ClassInfo[] {
  if (classNode.type !== "class_declaration" && classNode.type !== "interface_declaration") return [];
  const out: ClassInfo[] = [];
  const isInterface = classNode.type === "interface_declaration";
  if (find(cls.decorators, AUTO_VALUE) && !isInterface) {
    // `AutoValue_Outer_Inner` for a nested type.
    const path: string[] = [cls.name];
    for (let p = classNode.parent; p; p = p.parent) {
      if (p.type === "class_declaration" || p.type === "interface_declaration") {
        const n = p.childForFieldName("name")?.text;
        if (n) path.unshift(n);
      }
    }
    out.push(generatedClass(`AutoValue_${path.join("_")}`, cls, cls.name, [], []));
  }
  if (find(cls.decorators, IMMUTABLE) && !find(cls.decorators, /^(?:org\.immutables\.value\.)?Value\.Style\b/)) {
    const name = `Immutable${cls.name}`;
    // A simple, unique name: the written `ImmutableClub.Builder` is read by its last segment, which a hundred other builders share.
    const builderName = `${name}_Builder`;
    const attrs = valueAttributes(body);
    const methods: FunctionInfo[] = [synthetic("builder", [], builderName, cls.line), synthetic("copyOf", [{ name: "instance", type: cls.name, defaultValue: null }], name, cls.line)];
    // `of(…)` exists only where attributes are marked `@Value.Parameter`, in declaration order.
    const ofParams = attrs.filter((a) => a.parameter);
    if (ofParams.length > 0) methods.push(synthetic("of", ofParams.map((a) => ({ name: a.name, type: a.type, defaultValue: null })), name, cls.line));
    for (const a of attrs) methods.push(synthetic(`with${capitalize(a.name)}`, [{ name: a.name, type: a.type, defaultValue: null }], name, a.line));
    out.push(generatedClass(name, cls, isInterface ? null : cls.name, isInterface ? [cls.name] : [], methods));
    const builderMethods = attrs.map((a) => synthetic(a.name, [{ name: a.name, type: a.type, defaultValue: null }], builderName, a.line));
    builderMethods.push(synthetic("from", [{ name: "instance", type: cls.name, defaultValue: null }], builderName, cls.line), synthetic("build", [], name, cls.line));
    out.push(generatedClass(builderName, cls, null, [], builderMethods));
  }
  return out;
}
