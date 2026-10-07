import type { Node } from "web-tree-sitter";
import { stripQuotes } from "../../shared/node-helpers.js";
import { annotationArgsNode, isAnnotationNode } from "./routes/spring.js";

/**
 * Annotation reading for dependency injection, across both JVM grammars:
 * which annotations a declaration carries, their arguments, and the DI key an
 * injection point names (`@Qualifier("x")`, `@Named("x")`,
 * `@Resource(name = "x")`, a custom qualifier annotation).
 */

/**
 * Every annotation written on `decl`: direct children, its `modifiers` /
 * `parameter_modifiers` block, and — for a Kotlin function parameter — the
 * `parameter_modifiers` node tree-sitter-kotlin puts BEFORE the `parameter`
 * as its sibling (`fun f(@Named("x") r: Repo)`), not inside it.
 */
export function annotationNodes(decl: Node): Node[] {
  const out: Node[] = [];
  const take = (holder: Node): void => {
    for (const c of holder.children) if (isAnnotationNode(c)) out.push(c);
  };
  if (decl.type === "parameter") {
    const prev = decl.previousSibling;
    if (prev?.type === "parameter_modifiers") take(prev);
  }
  for (const child of decl.children) {
    if (isAnnotationNode(child)) out.push(child);
    else if (child.type === "modifiers" || child.type === "parameter_modifiers") take(child);
  }
  return out;
}

/**
 * Simple name of an annotation (`Named`, also for `@javax.inject.Named(…)`
 * and a Kotlin use-site target `@field:Named(…)`).
 */
export function annotationName(ann: Node): string | null {
  const nameField = ann.childForFieldName("name");
  if (nameField) return lastSegment(nameField.text);
  for (const child of ann.children) {
    if (child.type === "identifier" || child.type === "scoped_identifier") return lastSegment(child.text);
    const userType =
      child.type === "user_type" ? child
      : child.type === "constructor_invocation" ? child.children.find((c) => c.type === "user_type")
      : undefined;
    if (userType) {
      const ids = userType.children.filter((c) => c.type === "type_identifier");
      if (ids.length > 0) return ids[ids.length - 1]!.text;
    }
  }
  return null;
}

/** Kotlin use-site target of an annotation (`field` for `@field:Named`), or null. */
function useSiteTarget(ann: Node): string | null {
  const t = ann.children.find((c) => c.type === "use_site_target");
  return t ? t.text.replace(/:\s*$/, "").trim() : null;
}

/** Argument nodes of an annotation, split into positional values and `key = value` pairs. */
function annotationArgs(ann: Node): { positional: Node[]; named: Map<string, Node> } {
  const positional: Node[] = [];
  const named = new Map<string, Node>();
  const args = annotationArgsNode(ann);
  if (!args) return { positional, named };
  for (const a of args.namedChildren) {
    if (a.type === "element_value_pair") {
      // Java `key = value`.
      const key = a.childForFieldName("key")?.text;
      const value = a.childForFieldName("value");
      if (key && value) named.set(key, value);
    } else if (a.type === "value_argument") {
      // Kotlin: `value` or `key = value`.
      const kids = a.namedChildren;
      if (kids.length >= 2 && a.children.some((c) => c.type === "=") && kids[0]!.type === "simple_identifier") {
        named.set(kids[0]!.text, kids[kids.length - 1]!);
      } else if (kids.length > 0) {
        positional.push(kids[kids.length - 1]!);
      }
    } else if (a.type !== "line_comment" && a.type !== "block_comment" && a.type !== "multiline_comment") {
      positional.push(a);
    }
  }
  return { positional, named };
}

/**
 * The values of an annotation argument: the first positional argument when
 * `positional` is set, else the first of `keys` given by name. A string
 * literal yields its content, an array (`{"a","b"}`, `["a","b"]`,
 * `arrayOf(…)`) each element, a class literal its simple type name, and any
 * other expression (a constant) its source text — the same text the other
 * side of the binding spells it with. Null when the argument is absent.
 */
export function annotationValues(ann: Node, keys: readonly string[], positional = true): string[] | null {
  const { positional: pos, named } = annotationArgs(ann);
  let node: Node | undefined = positional ? pos[0] : undefined;
  if (!node) {
    for (const k of keys) {
      node = named.get(k);
      if (node) break;
    }
  }
  return node ? expressionValues(node) : null;
}

/** True when the annotation has an argument named `key` whose source text is `text` (`autowireCandidate = false`). */
export function annotationArgIs(ann: Node, key: string, text: string): boolean {
  return annotationArgs(ann).named.get(key)?.text.trim() === text;
}

/** Constant values of an argument expression (see `annotationValues`). */
export function expressionValues(node: Node): string[] {
  switch (node.type) {
    case "string_literal": {
      const s = constantString(node);
      return s === null ? [] : [s];
    }
    case "element_value_array_initializer":
    case "collection_literal":
    case "array_initializer":
      return node.namedChildren.flatMap(expressionValues);
    case "class_literal":
    case "callable_reference":
    case "navigation_expression": {
      const cls = classRefName(node);
      if (cls) return [cls];
      break;
    }
    case "call_expression": {
      // Kotlin `arrayOf("a", "b")`.
      const callee = node.children[0];
      if (callee?.type === "simple_identifier" && /^(?:arrayOf|listOf|setOf)$/.test(callee.text)) {
        const args = node.children.find((c) => c.type === "call_suffix")?.children.find((c) => c.type === "value_arguments");
        return (args?.namedChildren ?? []).flatMap((v) => (v.namedChildren.length > 0 ? expressionValues(v.namedChildren[v.namedChildren.length - 1]!) : []));
      }
      break;
    }
  }
  const text = node.text.replace(/\s+/g, "");
  return text ? [text] : [];
}

/** A string literal's content, or null when it interpolates (`"${x}"`, `"$x"`). */
export function constantString(node: Node): string | null {
  if (node.type !== "string_literal") return null;
  if (node.children.some((c) => c.type === "interpolated_expression" || c.type === "interpolated_identifier")) return null;
  return stripQuotes(node.text);
}

/**
 * Simple name of a class literal: Java `Foo.class` / `com.x.Foo.class`,
 * Kotlin `Foo::class` / `Foo::class.java`. Null for anything else.
 */
export function classRefName(node: Node): string | null {
  if (node.type === "class_literal") {
    const t = node.namedChildren[0];
    return t ? simpleName(t.text) : null;
  }
  if (node.type === "navigation_expression") {
    // `Foo::class.java`
    const [head, suffix] = node.children;
    if (head?.type === "callable_reference" && suffix?.text.replace(/\s+/g, "") === ".java") return classRefName(head);
    return null;
  }
  if (node.type === "callable_reference") {
    if (!node.children.some((c) => c.type === "class")) return null;
    const before = node.text.split("::")[0]!.trim();
    return before ? simpleName(before) : null;
  }
  return null;
}

/** `com.x.Foo<Bar>` → `Foo`. Null when the text is not a plain (qualified) type name. */
export function simpleName(typeText: string): string | null {
  const bare = typeText.replace(/<[\s\S]*$/, "").replace(/\?$/, "").replace(/\s+/g, "");
  const last = bare.split(".").pop() ?? "";
  return /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
}

function lastSegment(text: string): string {
  return text.replace(/.*\./, "").trim();
}

/** `URLParser` stays, `UserRepo` → `userRepo` (java.beans.Introspector.decapitalize — Spring's default bean name). */
export function decapitalize(name: string): string {
  if (name.length > 1 && isUpper(name[0]!) && isUpper(name[1]!)) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z";
}

/** Annotations that ask the container for an instance (an explicit injection point). */
const INJECT_MARKERS: ReadonlySet<string> = new Set(["Inject", "Autowired"]);

/** True when one of `anns` is `@Inject` / `@Autowired`. */
export function isInjectMarked(anns: readonly Node[]): boolean {
  return anns.some((a) => INJECT_MARKERS.has(annotationName(a) ?? ""));
}

/**
 * Annotations seen on injection points that are NOT qualifiers — nullability,
 * laziness, validation, Kotlin/Lombok plumbing, CDI's own `@Default`/`@Any`
 * (unqualified), Guice `@Assisted` (a factory argument).
 */
const NON_QUALIFIER_ANNOTATIONS: ReadonlySet<string> = new Set([
  "Inject", "Autowired", "Resource", "Value", "Lazy", "Optional",
  "Nullable", "NonNull", "Nonnull", "NotNull", "CheckForNull", "ParametersAreNonnullByDefault",
  "Valid", "Validated", "Override", "Deprecated", "SuppressWarnings", "Suppress",
  "JvmField", "JvmStatic", "JvmSuppressWildcards", "JvmWildcard", "Volatile", "Transient",
  "Getter", "Setter", "Default", "Any", "Assisted", "PersistenceContext", "PersistenceUnit",
  "Context", "ConfigProperty", "Property", "VisibleForTesting",
]);

/** `@field:` / `@param:` / `@set:` / `@setparam:` reach the injection point; `@get:` and `@property:` do not. */
const POINT_USE_SITES: ReadonlySet<string> = new Set(["field", "param", "set", "setparam", "constructor"]);

/**
 * The DI key an injection point names: `@Qualifier("x")` (Spring),
 * `@Named("x")` (JSR-330 / Jakarta), `@Resource(name = "x")`. A bare
 * `@Named` (CDI) names the member itself. With `custom` — the point is an
 * explicit `@Inject`/`@Autowired` one — any other annotation that is not a
 * known non-qualifier (`@Nullable`, `@Lazy`, …) is taken as a custom
 * qualifier annotation (`@Inject @Fast Sorter s` → `Fast`), the key a Guice
 * `annotatedWith(Fast.class)` or a Dagger `@Provides @Fast` registers under.
 * Taking an unknown annotation for a qualifier only ever narrows the
 * candidates (an unmatched key resolves to nothing); missing a real one would
 * let an unkeyed registration answer a keyed request.
 */
export function pointQualifier(anns: readonly Node[], memberName: string, custom: boolean): string | undefined {
  let customName: string | undefined;
  for (const ann of anns) {
    const target = useSiteTarget(ann);
    if (target && !POINT_USE_SITES.has(target)) continue;
    const name = annotationName(ann);
    if (!name) continue;
    if (name === "Qualifier" || name === "Named") {
      const v = annotationValues(ann, ["value"]);
      if (v && v[0]) return v[0];
      if (name === "Named" && memberName) return memberName;
      continue;
    }
    if (name === "Resource") {
      const v = annotationValues(ann, ["name"], false);
      if (v && v[0]) return v[0];
      continue;
    }
    if (custom && !customName && !NON_QUALIFIER_ANNOTATIONS.has(name)) customName = name;
  }
  return customName;
}
